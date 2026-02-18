import { CONFIG } from "../src/config.js";
import { PostgresTokenStore } from "../src/postgresTokenStore.js";
import { isExpired } from "../src/tokenStore.js";
import { refreshAccessToken } from "../src/oauth.js";
import { listSentMail, getMe, getMail } from "../src/graph.js";

/**
 * Usage:
 *   DATABASE_URL=... CLIENT_ID=... CLIENT_SECRET=... REDIRECT_URI=... TENANT_ID=common node scripts/readSentMailFromDb.js
 */

function required(name, val) {
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

async function main() {
  const databaseUrl = required("DATABASE_URL", process.env.DATABASE_URL);
  required("CLIENT_ID", CONFIG.clientId);
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
  const mailList = await listSentMail(accessToken, top);

  // Fetch full details for the most recent sent message
  let latestMessageDetail = null;
  if (mailList.value && mailList.value.length > 0) {
    const firstId = mailList.value[0].id;
    latestMessageDetail = await getMail(accessToken, firstId);
  }

  const summary = (mailList.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject,
    to: m.toRecipients?.map(r => r.emailAddress?.address).join(", ") || null,
    sent: m.receivedDateTime,
    bodyPreview: m.bodyPreview,
  }));

  console.log(
    JSON.stringify(
      {
        ok: true,
        user_key: userKey,
        me,
        latest_sent_message_detail: latestMessageDetail,
        sent_mail_list_summary: summary,
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

