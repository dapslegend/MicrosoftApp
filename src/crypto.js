import crypto from "node:crypto";

export function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function randomBase64UrlString(bytes = 32) {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

export function sha256Base64Url(str) {
  const hash = crypto.createHash("sha256").update(str).digest();
  return base64UrlEncode(hash);
}


