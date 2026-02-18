import { CONFIG } from "../src/config.js";
import { PostgresTokenStore } from "../src/postgresTokenStore.js";
import { isExpired } from "../src/tokenStore.js";
import { refreshAccessToken } from "../src/oauth.js";
import { graphGet } from "../src/graph.js";

/**
 * Usage: 
 *   DATABASE_URL=... node scripts/listAllMailboxes.js
 * 
 * Note: Requires 'Directory.Read.All' scope and an Admin user.
 */

async function main() {
  const store = new PostgresTokenStore(process.env.DATABASE_URL);
  await store.ensureSchema();

  const userKey = process.env.USER_KEY || await store.mostRecentUserKey();
  const saved = await store.load(userKey);
  if (!saved) throw new Error("No tokens found.");

  let token = saved.access_token;
  if (isExpired(saved)) {
    const refreshed = await refreshAccessToken({
      tenantId: CONFIG.tenantId,
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret,
      scopes: CONFIG.scopes,
      refreshToken: saved.refresh_token
    });
    await store.save(userKey, refreshed);
    token = refreshed.access_token;
  }

  console.log("Fetching organization mailboxes...");
  // This is the Graph equivalent of the Exchange Admin Center 'Mailboxes' list
  const users = await graphGet("/users?$select=displayName,mail,userPrincipalName,id&$top=100", token);

  console.log(JSON.stringify({
    ok: true,
    count: users.value?.length || 0,
    mailboxes: users.value?.map(u => ({
      name: u.displayName,
      email: u.mail || u.userPrincipalName
    }))
  }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
});

