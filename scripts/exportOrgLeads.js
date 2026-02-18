import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../src/config.js";

const OUTPUT = process.env.OUTPUT || path.join(process.cwd(), "leads-org.csv");
const MAX_USERS = Number(process.env.MAX_USERS || "50");
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || "500");
const FOLDER = (process.env.FOLDER || "all").toLowerCase();

function normalizeEmail(addr) {
  if (!addr) return null;
  return String(addr).trim().toLowerCase();
}

async function getAppToken() {
  const tenantId = CONFIG.tenantId;
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("CLIENT_ID, CLIENT_SECRET, TENANT_ID are required for app-only token");
  }
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error_description || json?.error || `Token request failed (${res.status})`;
    throw new Error(msg);
  }
  return json.access_token;
}

async function fetchPaged(url, accessToken, maxItems) {
  let next = url;
  const items = [];
  while (next && items.length < maxItems) {
    const res = await fetch(next, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || `Graph request failed (${res.status})`;
      throw new Error(msg);
    }
    const batch = json?.value || [];
    items.push(...batch);
    next = json["@odata.nextLink"] || null;
  }
  return items.slice(0, maxItems);
}

function collectFromMessage(map, meEmails, owner, msg, folderLabel) {
  const folder = folderLabel || msg.parentFolderId || "unknown";
  const msgDate = msg.sentDateTime || msg.receivedDateTime || null;
  const fromAddr = normalizeEmail(msg?.from?.emailAddress?.address);
  const fromName = msg?.from?.emailAddress?.name || "";
  const isFromMe = fromAddr ? meEmails.has(fromAddr) : false;

  const add = (addr, name, outgoing) => {
    const email = normalizeEmail(addr);
    if (!email) return;
    const entry = map.get(email) || {
      email,
      name: name || "",
      from_count: 0,
      to_count: 0,
      total: 0,
      first_seen: msgDate,
      last_seen: msgDate,
      folders: new Set(),
      owners: new Set(),
    };
    if (!entry.name && name) entry.name = name;
    entry.total += 1;
    if (outgoing) entry.from_count += 1;
    else entry.to_count += 1;
    if (!entry.first_seen || (msgDate && msgDate < entry.first_seen)) entry.first_seen = msgDate;
    if (!entry.last_seen || (msgDate && msgDate > entry.last_seen)) entry.last_seen = msgDate;
    entry.folders.add(folder);
    entry.owners.add(owner);
    map.set(email, entry);
  };

  if (fromAddr) add(fromAddr, fromName, isFromMe);

  const handleRecipients = (arr, outgoing) => {
    for (const r of arr || []) {
      const addr = r?.emailAddress?.address;
      const name = r?.emailAddress?.name || "";
      add(addr, name, outgoing);
    }
  };

  const treatAsOutgoing = isFromMe || folder.toLowerCase() === "sentitems";
  handleRecipients(msg.toRecipients, treatAsOutgoing);
  handleRecipients(msg.ccRecipients, treatAsOutgoing);
  handleRecipients(msg.bccRecipients, treatAsOutgoing);
}

function toCsv(map) {
  const header = [
    "email",
    "name",
    "from_count",
    "to_count",
    "total_messages",
    "first_seen",
    "last_seen",
    "folders",
    "owners",
  ];
  const lines = [header.join(",")];
  for (const entry of map.values()) {
    const row = [
      entry.email,
      entry.name?.replace(/"/g, ""),
      entry.from_count,
      entry.to_count,
      entry.total,
      entry.first_seen || "",
      entry.last_seen || "",
      Array.from(entry.folders).join(";"),
      Array.from(entry.owners).join(";"),
    ];
    lines.push(row.map((v) => (v === null || v === undefined ? "" : String(v))).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const accessToken = await getAppToken();

  // Fetch users
  const usersUrl = "https://graph.microsoft.com/v1.0/users?$select=id,mail,userPrincipalName&$top=999";
  const users = await fetchPaged(usersUrl, accessToken, MAX_USERS);
  if (!users.length) throw new Error("No users found");

  const map = new Map();
  const select = "$select=id,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,parentFolderId";

  for (const u of users) {
    const owner = normalizeEmail(u.mail) || normalizeEmail(u.userPrincipalName) || u.id;
    const meEmails = new Set([normalizeEmail(u.mail), normalizeEmail(u.userPrincipalName)].filter(Boolean));

    const inboxUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.id)}/messages?$top=50&${select}&$orderby=receivedDateTime desc`;
    const sentUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.id)}/mailFolders/sentitems/messages?$top=50&${select}&$orderby=sentDateTime desc`;

    if (FOLDER === "all" || FOLDER === "inbox" || FOLDER === "messages") {
      const msgs = await fetchPaged(inboxUrl, accessToken, MAX_MESSAGES);
      for (const m of msgs) collectFromMessage(map, meEmails, owner, m, m.parentFolderId || "messages");
    }

    if (FOLDER === "all" || FOLDER === "sent" || FOLDER === "sentitems") {
      const msgs = await fetchPaged(sentUrl, accessToken, MAX_MESSAGES);
      for (const m of msgs) collectFromMessage(map, meEmails, owner, m, "sentitems");
    }
  }

  const csv = toCsv(map);
  await fs.writeFile(OUTPUT, csv, "utf8");
  console.log(`✅ Wrote ${map.size} leads to ${OUTPUT}`);
  console.log(`Users scanned: ${users.length} (cap via MAX_USERS env)`);
  console.log(`Messages per mailbox: up to ${MAX_MESSAGES} (set MAX_MESSAGES env)`);
  console.log("Requires app permissions: User.Read.All and Mail.Read (app) or Mail.ReadWrite (app). Admin consent needed.");
}

main().catch((err) => {
  console.error("Export failed:", err?.message || err);
  process.exit(1);
});
