import { CONFIG } from "../src/config.js";
import { PostgresTokenStore } from "../src/postgresTokenStore.js";
import { isExpired } from "../src/tokenStore.js";
import { refreshAccessToken } from "../src/oauth.js";
import { listMail, getMe, getMail } from "../src/graph.js";

/**
 * Usage:
 *   DATABASE_URL=... CLIENT_ID=... CLIENT_SECRET=... REDIRECT_URI=... TENANT_ID=common node scripts/readMailFromDb.js
 *
 * Optional:
 *   USER_KEY=tid:userid   (if omitted, uses most recently saved user)
 *   TOP=10               (default 10)
 */

function required(name, val) {
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

async function main() {
  const databaseUrl = required("DATABASE_URL", process.env.DATABASE_URL);
  required("CLIENT_ID", CONFIG.clientId);
  // For confidential web app flows (Render), refresh/token exchange requires secret.
  required("CLIENT_SECRET", CONFIG.clientSecret);

  const store = new PostgresTokenStore(databaseUrl);
  await store.ensureSchema();

  const userKey = process.env.USER_KEY || (await store.mostRecentUserKey());
  if (!userKey) throw new Error("No users in DB. Complete /auth/start + /callback first.");

  const saved = await store.load(userKey);
  if (!saved) throw new Error(`No tokens found for user_key=${userKey}`);

  let accessToken = saved.access_token;
  if (!accessToken || isExpired(saved, CONFIG.refreshSkewSeconds)) {
    if (!saved.refresh_token) throw new Error("Token expired and no refresh_token present.");
    const refreshed = await refreshAccessToken({
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret,
      scopes: CONFIG.scopes,
      refreshToken: saved.refresh_token,
    });
    const expiresAt = new Date(Date.now() + (refreshed.expires_in || 0) * 1000).toISOString();
    const merged = {
      ...saved,
      ...refreshed,
      expires_at: expiresAt,
      scope: refreshed.scope || saved.scope,
    };
    await store.save(userKey, merged);
    accessToken = merged.access_token;
  }

  const me = await getMe(accessToken);
  const top = Number(process.env.TOP || 10);
  const mailList = await listMail(accessToken, top);

  // Fetch full details (including body) for the most recent message
  let latestMessageDetail = null;
  if (mailList.value && mailList.value.length > 0) {
    const firstId = mailList.value[0].id;
    latestMessageDetail = await getMail(accessToken, firstId);
  }

  const summary = (mailList.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    received: m.receivedDateTime,
    bodyPreview: m.bodyPreview,
  }));

  console.log(
    JSON.stringify(
      {
        ok: true,
        user_key: userKey,
        me,
        latest_message_detail: latestMessageDetail,
        mail_list_summary: summary,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  process.exit(1);
});


