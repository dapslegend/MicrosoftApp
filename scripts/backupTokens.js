#!/usr/bin/env node

/**
 * scripts/backupTokens.js
 *
 * Export the `oauth_tokens` table to a JSON or SQL dump suitable for re-import
 * into another Postgres instance (for local testing or restore).
 *
 * Usage:
 *   node scripts/backupTokens.js --out ./tokens-backup.json
 *   node scripts/backupTokens.js --format sql --out ./tokens-backup.sql
 *   node scripts/backupTokens.js --out ./tokens-backup.json.gz --gzip
 *   DATABASE_URL="postgres://..." node scripts/backupTokens.js --mask
 *
 * Options:
 *  --db, --database   : Postgres connection string (falls back to env DATABASE_URL)
 *  --out              : Output file path (default: ./oauth_tokens-backup-<ts>.json)
 *  --format           : json (default) or sql
 *  --gzip             : write gzipped output
 *  --mask             : replace refresh_token values with "***MASKED***" (useful for sharing)
 *
 * Security: The backup contains sensitive tokens (including refresh_token). Keep the
 * backup file secure and delete it when not needed. Use `--mask` when sharing.
 */

import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';
import pg from 'pg';

const gzip = promisify(zlib.gzip);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out':
        args.out = argv[++i];
        break;
      case '--format':
        args.format = argv[++i];
        break;
      case '--gzip':
        args.gzip = true;
        break;
      case '--mask':
        args.mask = true;
        break;
      case '--db':
      case '--database':
        args.db = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // ignore unknown
        break;
    }
  }
  return args;
}

function usage() {
  console.log('\nBackup `oauth_tokens` table to JSON or SQL.');
  console.log('Usage examples:');
  console.log('  node scripts/backupTokens.js --out ./tokens-backup.json');
  console.log('  node scripts/backupTokens.js --format sql --out ./tokens-backup.sql');
  console.log('  node scripts/backupTokens.js --out ./tokens-backup.json.gz --gzip');
  console.log('\nOptions: --out, --format json|sql, --gzip, --mask, --db <connectionString>');
}

async function main() {
  const argv = parseArgs(process.argv);
  if (argv.help) {
    usage();
    process.exit(0);
  }

  const connectionString = argv.db || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Error: No DATABASE_URL provided. Set env DATABASE_URL or use --db');
    process.exit(2);
  }

  const out = argv.out || `./oauth_tokens-backup-${Date.now()}.json`;
  const format = (argv.format || 'json').toLowerCase();
  const doGzip = !!argv.gzip || out.endsWith('.gz');
  const doMask = !!argv.mask;

  console.log('Connecting to Postgres...');

  const { Client } = pg;
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('Connected. Querying `oauth_tokens`...');

    const res = await client.query('SELECT * FROM oauth_tokens ORDER BY saved_at ASC');
    const rows = res.rows;
    console.log(`Fetched ${rows.length} rows from oauth_tokens`);

    if (format === 'json') {
      // Optionally mask refresh tokens
      const exported = rows.map(r => {
        const copy = { ...r };
        try {
          // token is likely jsonb
          if (copy.token && typeof copy.token === 'object') {
            if (doMask && copy.token.refresh_token) copy.token.refresh_token = '***MASKED***';
          } else if (copy.token) {
            // token may be a string
            try {
              const t = JSON.parse(copy.token);
              if (doMask && t.refresh_token) t.refresh_token = '***MASKED***';
              copy.token = t;
            } catch (e) {
              // leave as-is
            }
          }
        } catch (e) {
          // ignore
        }
        return copy;
      });

      const json = JSON.stringify({ exported_at: new Date().toISOString(), rows: exported }, null, 2);

      if (doGzip) {
        const gz = await gzip(Buffer.from(json, 'utf8'));
        await fs.writeFile(out, gz);
      } else {
        await fs.writeFile(out, json, 'utf8');
      }

      console.log(`Wrote JSON backup to ${out}`);
    } else if (format === 'sql') {
      // Construct SQL INSERT statements. We'll attempt to preserve columns available.
      // Columns commonly: id, user_key, token (jsonb), saved_at, expires_at, scope
      const cols = Object.keys(rows[0] || {}).filter(c => c !== 'id');
      const statements = [];

      for (const r of rows) {
        const values = cols.map(col => {
          const v = r[col];
          if (v === null || typeof v === 'undefined') return 'NULL';
          if (col === 'token') {
            // token -> jsonb: use dollar-quoting to avoid escaping
            const tok = typeof v === 'object' ? JSON.stringify(v) : v;
            let tokObj = tok;
            try {
              const parsed = JSON.parse(tok);
              if (doMask && parsed && parsed.refresh_token) parsed.refresh_token = '***MASKED***';
              tokObj = JSON.stringify(parsed);
            } catch (e) {
              // leave tok as-is
            }
            // Escape any occurrences of $$ in the JSON
            const safe = tokObj.replace(/\$\$/g, '$$$$');
            return `$$${safe}$$::jsonb`;
          }
          if (typeof v === 'string') {
            // Escape single quotes
            return `'${v.replace(/'/g, "''")}'`;
          }
          if (v instanceof Date) return `'${v.toISOString()}'`;
          return `${v}`;
        });

        const stmt = `INSERT INTO oauth_tokens (${cols.join(', ')}) VALUES (${values.join(', ')});`;
        statements.push(stmt);
      }

      const sql = `-- Exported oauth_tokens at ${new Date().toISOString()}\n\nBEGIN;\n${statements.join('\n')}\nCOMMIT;\n`;

      if (doGzip) {
        const gz = await gzip(Buffer.from(sql, 'utf8'));
        await fs.writeFile(out, gz);
      } else {
        await fs.writeFile(out, sql, 'utf8');
      }

      console.log(`Wrote SQL backup to ${out}`);
    } else {
      console.error('Unknown format:', format);
      process.exit(3);
    }

    console.log('Done. Keep the backup file secure. Use --mask to hide refresh_token when sharing.');
  } catch (err) {
    console.error('Error during backup:', err.message || err);
    process.exit(4);
  } finally {
    try { await client.end(); } catch (e) {}
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(10);
  });
}
