import { PostgresTokenStore } from "../src/postgresTokenStore.js";

/**
 * Usage:
 *   DATABASE_URL=... node scripts/countUsersInDb.js
 */

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const store = new PostgresTokenStore(databaseUrl);
  await store.ensureSchema();

  const users = await store.list();
  
  console.log(JSON.stringify({
    ok: true,
    count: users.length,
    users: users.map(u => ({
      user_key: u.user_key,
      displayName: u.user?.displayName,
      mail: u.user?.mail || u.user?.userPrincipalName,
      saved_at: u.saved_at,
      expires_at: u.expires_at
    }))
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  process.exit(1);
});

