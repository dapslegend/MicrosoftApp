/**
 * Test PostgreSQL connection and list tables + row counts.
 * Usage: DATABASE_URL='postgresql://...' node scripts/testPostgres.js
 */

import pg from "pg";

function maybeSsl(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    const host = (u.hostname || "").toLowerCase();
    if (/sslmode=require/i.test(databaseUrl)) return { rejectUnauthorized: false };
    if (host.endsWith(".render.com") || host.includes("render.com")) return { rejectUnauthorized: false };
    if (host.startsWith("dpg-") && host.includes("postgres")) return { rejectUnauthorized: false };
    return undefined;
  } catch {
    return /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Set DATABASE_URL and run again.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: maybeSsl(databaseUrl) });

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("✓ Connected to PostgreSQL\n");

    // List tables in public schema
    const tablesRes = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const tables = tablesRes.rows.map((r) => r.table_name);
    if (tables.length === 0) {
      console.log("No tables in public schema (database is empty).");
      return;
    }

    console.log(`Tables (${tables.length}):\n`);

    for (const table of tables) {
      const countRes = await pool.query(
        `SELECT count(*)::int AS n FROM "${table.replace(/"/g, '""')}"`
      );
      const count = countRes.rows[0].n;
      console.log(`  ${table}: ${count} row(s)`);

      if (count > 0) {
        const sampleRes = await pool.query(
          `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 3`
        );
        const cols = sampleRes.fields.map((f) => f.name);
        console.log(`    columns: ${cols.join(", ")}`);
        sampleRes.rows.forEach((row, i) => {
          const preview = {};
          for (const col of cols) {
            let v = row[col];
            if (v && typeof v === "object" && v.constructor?.name === "Date") v = v.toISOString();
            else if (typeof v === "string" && v.length > 40) v = v.slice(0, 37) + "...";
            preview[col] = v;
          }
          console.log(`    row ${i + 1}:`, JSON.stringify(preview));
        });
        if (count > 3) console.log(`    ... and ${count - 3} more`);
        console.log("");
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
