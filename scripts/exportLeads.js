import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import { TokenStore, isExpired } from "../src/tokenStore.js";
import { PostgresTokenStore } from "../src/postgresTokenStore.js";
import { refreshAccessToken } from "../src/oauth.js";
import { getMe } from "../src/graph.js";

const OUTPUT = process.env.OUTPUT || path.join(process.cwd(), "leads.csv");
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || "2000");
const FOLDER = (process.env.FOLDER || "all").toLowerCase();

function normalizeEmail(addr) {
  if (!addr) return null;
  return String(addr).trim().toLowerCase();
}

async function getStore() {
  if (process.env.DATABASE_URL) {
    const store = new PostgresTokenStore(process.env.DATABASE_URL);
    await store.ensureSchema();
    return store;
  }
  return new TokenStore();
}

async function pickUserKey(store) {
  if (process.env.USER_KEY) return process.env.USER_KEY;
  if (typeof store.mostRecentUserKey === "function") {
    const uk = await store.mostRecentUserKey();
    if (uk) return uk;
  }
  const list = await store.list();
  if (list?.length) return list[0].user_key;
  throw new Error("No users found. Run /auth/start first.");
}

async function getValidAccessToken(store, userKey) {
  const saved = await store.load(userKey);
  if (!saved) throw new Error(`No tokens for user_key=${userKey}`);

  if (saved.access_token && !isExpired(saved, CONFIG.refreshSkewSeconds)) {
    return { accessToken: saved.access_token, saved };
  }
  if (!saved.refresh_token) throw new Error("Token expired and no refresh_token present.");

  const refreshed = await refreshAccessToken({
    tenantId: CONFIG.tenantId,
    clientId: CONFIG.clientId,
    clientSecret: CONFIG.clientSecret,
    scopes: CONFIG.scopes,
    refreshToken: saved.refresh_token,
  });
  const expiresAt = new Date(Date.now() + (refreshed.expires_in || 0) * 1000).toISOString();
  const merged = { ...saved, ...refreshed, expires_at: expiresAt, scope: refreshed.scope || saved.scope };
  await store.save(userKey, merged);
  return { accessToken: merged.access_token, saved: merged };
}

async function fetchAll(accessToken, startUrl) {
  let url = startUrl;
  const items = [];
  while (url && items.length < MAX_MESSAGES) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || `Graph request failed (${res.status})`;
      throw new Error(msg);
    }
    const batch = json?.value || [];
    items.push(...batch);
    const nextLink = json["@odata.nextLink"];
    url = nextLink || null;
  }
  return items;
}

function collectFromMessage(map, meEmails, msg, folderLabel) {
  const folder = folderLabel || msg.parentFolderId || "unknown";
  const msgDate = msg.sentDateTime || msg.receivedDateTime || null;
  const fromAddr = normalizeEmail(msg?.from?.emailAddress?.address);
  const fromName = msg?.from?.emailAddress?.name || "";
  const isFromMe = fromAddr ? meEmails.has(fromAddr) : false;

  const add = (addr, name, outgoing) => {
    const email = normalizeEmail(addr);
    if (!email) return;
    if (meEmails.has(email)) return; // skip self
    const entry = map.get(email) || {
      email,
      name: name || "",
      from_me_count: 0,
      to_me_count: 0,
      total: 0,
      first_seen: msgDate,
      last_seen: msgDate,
      folders: new Set(),
    };
    if (!entry.name && name) entry.name = name;
    entry.total += 1;
    if (outgoing) entry.from_me_count += 1;
    else entry.to_me_count += 1;
    if (!entry.first_seen || (msgDate && msgDate < entry.first_seen)) entry.first_seen = msgDate;
    if (!entry.last_seen || (msgDate && msgDate > entry.last_seen)) entry.last_seen = msgDate;
    entry.folders.add(folder);
    map.set(email, entry);
  };

  // from (incoming)
  if (fromAddr && !isFromMe) add(fromAddr, fromName, false);

  const handleRecipients = (arr, outgoing) => {
    for (const r of arr || []) {
      const addr = r?.emailAddress?.address;
      const name = r?.emailAddress?.name || "";
      add(addr, name, outgoing);
    }
  };

  // recipients; outgoing if we sent it, or if we're in Sent folder
  const treatAsOutgoing = isFromMe || folder.toLowerCase() === "sentitems";
  handleRecipients(msg.toRecipients, treatAsOutgoing);
  handleRecipients(msg.ccRecipients, treatAsOutgoing);
  handleRecipients(msg.bccRecipients, treatAsOutgoing);
}

function toCsv(map) {
  const header = [
    "email",
    "name",
    "from_me_count",
    "to_me_count",
    "total_messages",
    "first_seen",
    "last_seen",
    "folders",
  ];
  const lines = [header.join(",")];
  for (const entry of map.values()) {
    const row = [
      entry.email,
      entry.name?.replace(/"/g, ""),
      entry.from_me_count,
      entry.to_me_count,
      entry.total,
      entry.first_seen || "",
      entry.last_seen || "",
      Array.from(entry.folders).join(";") || "",
    ];
    lines.push(row.map((v) => (v === null || v === undefined ? "" : String(v))).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const store = await getStore();
  const userKey = await pickUserKey(store);
  const { accessToken, saved } = await getValidAccessToken(store, userKey);
  const me = await getMe(accessToken);
  const meEmails = new Set([
    normalizeEmail(me?.mail),
    normalizeEmail(me?.userPrincipalName),
  ].filter(Boolean));

  const select = "$select=id,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,parentFolderId";
  const base = `https://graph.microsoft.com/v1.0/me/messages?$top=50&${select}&$orderby=receivedDateTime desc`;
  const sent = `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=50&${select}&$orderby=sentDateTime desc`;

  const map = new Map();

  if (FOLDER === "all" || FOLDER === "inbox" || FOLDER === "messages") {
    const msgs = await fetchAll(accessToken, base);
    for (const m of msgs) collectFromMessage(map, meEmails, m, m.parentFolderId || "messages");
  }

  if (FOLDER === "all" || FOLDER === "sent" || FOLDER === "sentitems") {
    const msgs = await fetchAll(accessToken, sent);
    for (const m of msgs) collectFromMessage(map, meEmails, m, "sentitems");
  }

  const csv = toCsv(map);
  await fs.writeFile(OUTPUT, csv, "utf8");
  console.log(`✅ Wrote ${map.size} leads to ${OUTPUT}`);
  console.log(`User: ${userKey}`);
  console.log(`Messages scanned: up to ${MAX_MESSAGES} per folder (use MAX_MESSAGES env to change)`);
  console.log("Set FOLDER=sent or FOLDER=all to control sources (default all).");
  console.log("Set OUTPUT=/path/file.csv to change destination.");
  console.log("Set USER_KEY=... to choose account.");
}

main().catch((err) => {
  console.error("Export failed:", err?.message || err);
  process.exit(1);
});
