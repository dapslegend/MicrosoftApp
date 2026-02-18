import { randomBase64UrlString, sha256Base64Url } from "./crypto.js";

function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required config: ${name}`);
  return val;
}

export function buildAuthState() {
  const codeVerifier = randomBase64UrlString(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = randomBase64UrlString(16);
  const nonce = randomBase64UrlString(16);
  return { codeVerifier, codeChallenge, state, nonce };
}

export function getAuthorityBase(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
}

export function buildAuthorizeUrl({
  tenantId,
  clientId,
  redirectUri,
  scopes,
  state,
  nonce,
  codeChallenge,
}) {
  requireEnv("TENANT_ID", tenantId);
  requireEnv("CLIENT_ID", clientId);
  requireEnv("REDIRECT_URI", redirectUri);

  const authBase = `${getAuthorityBase(tenantId)}/authorize`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes.join(" "),
    prompt: "consent",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${authBase}?${params.toString()}`;
}

export async function exchangeCodeForTokens({
  tenantId,
  clientId,
  clientSecret,
  redirectUri,
  scopes,
  code,
  codeVerifier,
}) {
  const tokenUrl = `${getAuthorityBase(tenantId)}/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error_description || json?.error || `Token exchange failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

export async function refreshAccessToken({
  tenantId,
  clientId,
  clientSecret,
  scopes,
  refreshToken,
}) {
  const tokenUrl = `${getAuthorityBase(tenantId)}/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error_description || json?.error || `Token refresh failed (${res.status})`;
    throw new Error(msg);
  }
  return json;
}


