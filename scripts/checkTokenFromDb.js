import { CONFIG } from "../src/config.js";
import { PostgresTokenStore } from "../src/postgresTokenStore.js";
import { isExpired } from "../src/tokenStore.js";

/**
 * Usage:
 *   DATABASE_URL=... [USER_KEY=...] [SKEW_SECONDS=300] node scripts/checkTokenFromDb.js
 */

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const store = new PostgresTokenStore(databaseUrl);
  await store.ensureSchema();

  const userKey = process.env.USER_KEY || (await store.mostRecentUserKey());
  if (!userKey) {
    console.log(JSON.stringify({ ok: false, error: "No users found in database." }, null, 2));
    return;
  }

  const saved = await store.load(userKey);
  if (!saved) {
    console.log(JSON.stringify({ ok: false, error: `No tokens found for user: ${userKey}` }, null, 2));
    return;
  }

  const skew = Number(process.env.SKEW_SECONDS || CONFIG.refreshSkewSeconds || 300);
  const expired = isExpired(saved, skew);
  
  const status = {
    ok: true,
    user_key: userKey,
    user: saved.user,
    token_status: {
      access_token_present: !!saved.access_token,
      refresh_token_present: !!saved.refresh_token,
      expires_at: saved.expires_at,
      expired_with_skew: expired,
      skew_seconds: skew,
      saved_at: saved.saved_at,
      scopes: saved.scope
    }
  };

  console.log(JSON.stringify(status, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  process.exit(1);
});

