# Refresh Tokens & App Setup Guide

## When you need a refresh token
- Use **delegated** OAuth (auth code + PKCE) with scopes that include `offline_access`.
- App-only (`.default`, client_credentials) never returns refresh tokens.
- Each user consent is tied to the app registration and its redirect URI.

## How to build / re-consent a new app (or expired tokens)
1) **Create/confirm the app registration** in Entra:
   - Type: Web (server-side) is fine.
   - Redirect URI: must match `REDIRECT_URI` in `config.env` (e.g., `http://localhost:3000/callback` or your deployed URL).
   - For delegated: you do not strictly need a client secret for public/PKCE, but a secret is fine if your server redeems the code.
2) **Add delegated API permissions** (what users will consent to):
   - `openid profile offline_access`
   - `User.Read` (+ `User.Read.All` if needed)
   - Mail: `Mail.Read` `Mail.ReadWrite` `Mail.Send`
   - Calendars: `Calendars.ReadWrite`
   - Contacts: `Contacts.ReadWrite`
   - Files: `Files.ReadWrite.All`
   - Sites: `Sites.ReadWrite.All`
   - Mailbox settings: `MailboxSettings.ReadWrite`
   - Directory data: `Directory.Read.All` (admin consent required)
   - Adjust to the minimum you actually need.
3) **Update `config.env`**:
   - `TENANT_ID=<your-tenant-id>` (or `common` for multi-tenant)
   - `CLIENT_ID=<app-client-id>`
   - `CLIENT_SECRET=<secret>` (if using confidential flow)
   - `SCOPES=<space-separated delegated scopes>` including `offline_access`
   - Example: `SCOPES=openid profile offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All Sites.ReadWrite.All Directory.Read.All`
4) **Restart the server** so it picks up env changes.
5) **Re-consent the user**:
   - Visit `/auth/start`, sign in as the user (e.g., `reservations@...`), approve the consent.
   - This stores `access_token`, `refresh_token`, `expires_at` in the token store (filesystem or Postgres).
6) **Verify refresh token is stored** (Postgres example):
   ```bash
   DATABASE_URL=... node -e "import pg from 'pg'; const {Client}=pg; (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}); await c.connect(); const r=await c.query('SELECT user_key, token::jsonb ? '"'"'refresh_token'"'"' AS has_refresh, (token->>'"'"'expires_at'"'"') AS expires_at FROM oauth_tokens ORDER BY saved_at DESC'); console.log(r.rows); await c.end();})();"
   ```

## Refresh behavior in this project
- **server.js** automatically refreshes when `isExpired` detects an access token near expiry (uses the stored `refresh_token`).
- The email sender script also refreshes on demand.
- Background refresh loop: controlled by `REFRESH_EVERY_SECONDS` (set in `config.env`); when >0, it periodically refreshes tokens.

### Code pattern: fetch tokens from DB and refresh (for new tools/AI agents)
```js
import { PostgresTokenStore } from "./src/postgresTokenStore.js";
import { CONFIG } from "./src/config.js";
import { isExpired } from "./src/tokenStore.js";
import { refreshAccessToken } from "./src/oauth.js";

async function getFreshAccessToken(userKey) {
   const store = new PostgresTokenStore(process.env.DATABASE_URL);
   await store.ensureSchema();
   const saved = await store.load(userKey);
   if (!saved) throw new Error(`No tokens for ${userKey}`);

   // If not expired, return existing access token
   if (saved.access_token && !isExpired(saved, CONFIG.refreshSkewSeconds)) {
      return { accessToken: saved.access_token, saved };
   }

   if (!saved.refresh_token) throw new Error("No refresh_token available; re-consent needed");

   // Refresh
   const refreshed = await refreshAccessToken({
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret,
      scopes: CONFIG.scopes,
      refreshToken: saved.refresh_token,
   });

   const expiresAt = new Date(Date.now() + (refreshed.expires_in || 0) * 1000).toISOString();
   const merged = { ...saved, ...refreshed, expires_at: expiresAt, scope: refreshed.scope || saved.scope };
   await store.save(userKey, merged);
   return { accessToken: merged.access_token, saved: merged };
}
```

Use this pattern in any AI-generated scripts that need to read mail (similar to the email sender). It reads tokens from Postgres, refreshes if needed, and persists the updated token before returning the access token.

To confirm refresh tokens exist without printing secrets:
```bash
DATABASE_URL="..." node -e "import pg from 'pg'; const {Client}=pg; (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}); await c.connect(); const r=await c.query(`SELECT user_key, token::jsonb ? 'refresh_token' AS has_refresh FROM oauth_tokens ORDER BY saved_at DESC`); console.log(r.rows); await c.end();})();"
```

## If tokens expire or are revoked
- Simply re-run `/auth/start` with the same app and scopes; the stored token will be replaced with a fresh `access_token` and `refresh_token`.
- If you change scopes (add/remove), re-consent is required.

## App-only vs delegated
- **Delegated** (what we use for refresh tokens): requires user sign-in; scopes listed in `SCOPES`; includes `offline_access`.
- **App-only** (`.default` with client_credentials): no user, no refresh token; uses application permissions granted by an admin; useful for org-wide/background tasks but cannot yield refresh tokens.

## Tips
- Ensure the consent screen lists `offline_access`; if not, your `SCOPES` env is wrong or you’re using `.default`.
- For multi-tenant, keep `TENANT_ID=common`; for single-tenant, use your directory ID.
- Keep redirect URI exactly matching the Entra app registration.
- Store secrets outside git; env vars or secret managers.
