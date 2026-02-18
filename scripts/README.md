**Scripts Readme**
- **Purpose**: Quick reference for the utility scripts in `scripts/` used to send emails, export leads, and backup token storage.

**Prerequisites**
- Node.js installed (project uses ESM imports).
- From the project root, set `DATABASE_URL` when connecting to Postgres (or pass `--db` to scripts).
- Protect any produced backup files — they contain sensitive tokens (refresh tokens).

**Scripts**

- **`sendEmails.js`**: Send personalized emails using CSV data and stored OAuth tokens.
  - Location: `scripts/sendEmails.js`
  - Summary: Reads CSV files in `src/` and `emails.txt` in project root; matches addresses and sends personalized messages using a stored user token.
  - Important: The script will read `emails.txt` (one email per line) and match those addresses with CSV rows in `src/` (CSV must include an `Email` column).
  - Examples:

```bash
# List available stored user keys
node scripts/sendEmails.js --list

# Test run (10 emails)
node scripts/sendEmails.js --user-key "<USER_KEY>" --max-emails 10

# Full batch (script limit applies; default throttling is 70 emails per 12 hours)
node scripts/sendEmails.js --user-key "<USER_KEY>"

# Don't save to Sent Items
node scripts/sendEmails.js --user-key "<USER_KEY>" --no-save

# Override subject (supports placeholders like ##FIRSTNAME## and ##LASTNAME##)
node scripts/sendEmails.js --user-key "<USER_KEY>" --subject "Reservation for ##FIRSTNAME## ##LASTNAME##"
```

- **`backupTokens.js`**: Export the `oauth_tokens` table for safe local restore or testing.
  - Location: `scripts/backupTokens.js`
  - Summary: Connects to Postgres (via `DATABASE_URL` or `--db`) and writes either JSON or SQL insert dump. Supports gzip and masking refresh tokens.
  - Options:
    - `--out <file>` : Output file path (default `./oauth_tokens-backup-<ts>.json`).
    - `--format json|sql` : Output format (default `json`).
    - `--gzip` : Write gzipped output.
    - `--mask` : Replace `refresh_token` values with `***MASKED***` (useful when sharing).
    - `--db <connectionString>` : Provide DB URL on the command line instead of `DATABASE_URL`.
  - Examples:

```bash
# JSON backup using DATABASE_URL env
node scripts/backupTokens.js --out ./oauth_tokens-backup.json

# Gzipped JSON
node scripts/backupTokens.js --out ./oauth_tokens-backup.json.gz --gzip

# SQL dump for re-import
node scripts/backupTokens.js --format sql --out ./oauth_tokens-backup.sql

# Mask refresh tokens before sharing
node scripts/backupTokens.js --out ./oauth_tokens-mask.json --mask

# Provide DB on the command line
node scripts/backupTokens.js --db "postgresql://user:pass@host:5432/dbname" --out ./backup.json
```

**Security & Safety Notes**
- Backup files contain sensitive data (access/refresh tokens). Store them securely (encrypted disk, S3 with restricted access, etc.) and delete them when not needed.
- Use `--mask` before sharing backups publicly. Masking replaces refresh tokens with `***MASKED***` but still includes other metadata needed for debugging.
- When re-importing SQL dumps, ensure the target `oauth_tokens` table schema matches the source. Importing into a production DB can overwrite or duplicate rows — prefer local dev copies.

**CSV / emails.txt guidance for `sendEmails.js`**
- Place your CSV files in `src/` (the script looks for `*.csv`). CSVs must have an `Email` header (case-sensitive) for matching.
- Create `emails.txt` in the project root; one email address per line. The script will match addresses from `emails.txt` with CSV rows and only send to matched addresses.
- Example: create `emails.txt` from `src/export*.csv` (this project provides a sample extraction command):

```bash
awk -F, 'NR==1{for(i=1;i<=NF;i++){h[i]=$i; if($i=="Email")c=i}} NR>1 && $c!=""{gsub(/"/,"",$c); print $c}' src/export*.csv | sed 's/^[ \t]*//;s/[ \t]*$//' | grep -E '@' | sort -u > emails.txt
```

**Troubleshooting**
- If the script reports no stored users, open the web UI and authenticate a delegated user so their tokens are saved to the DB.
- If tokens are expired and you have `CLIENT_SECRET` configured, the scripts will attempt to refresh automatically. If refresh fails, re-authenticate the user via the web flow.

**Contact / Next Steps**
- To run a test backup here, or to produce a masked backup file, ask and I can run the command using the current `DATABASE_URL` and place the output in the repo.

