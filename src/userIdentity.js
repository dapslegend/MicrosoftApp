function base64UrlToUtf8(str) {
  // Add padding if needed
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

export function parseJwtWithoutVerify(jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlToUtf8(parts[1]));
  } catch {
    return null;
  }
}

export function buildUserKey({ tenantId, userId }) {
  const tid = tenantId || "unknown";
  const uid = userId || "unknown";
  return `${tid}:${uid}`;
}

export function identityFromTokensAndMe({ tokens, me }) {
  const claims = parseJwtWithoutVerify(tokens?.id_token);
  const tenantId = claims?.tid || claims?.tenant_region_scope || "unknown";
  const userId = me?.id || claims?.oid || claims?.sub || "unknown";

  return {
    userKey: buildUserKey({ tenantId, userId }),
    user: {
      tenantId,
      id: me?.id || claims?.oid || claims?.sub,
      displayName: me?.displayName,
      userPrincipalName: me?.userPrincipalName,
      mail: me?.mail,
    },
  };
}


