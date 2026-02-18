export async function graphGet(path, accessToken) {
  const url = path.startsWith("https://") ? path : `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.error_description ||
      `Graph request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

// Generic POST helper for Graph API
export async function graphPost(path, accessToken, body = {}) {
  const url = path.startsWith("https://") ? path : `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 201 || res.status === 202 || res.status === 204) {
    const text = await res.text();
    return text ? JSON.parse(text) : { success: true };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Graph POST failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

// Generic PATCH helper for Graph API
export async function graphPatch(path, accessToken, body = {}) {
  const url = path.startsWith("https://") ? path : `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 200 || res.status === 204) {
    const text = await res.text();
    return text ? JSON.parse(text) : { success: true };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Graph PATCH failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

export async function getMe(accessToken) {
  return await graphGet("/me?$select=id,displayName,userPrincipalName,mail", accessToken);
}

export async function listMail(accessToken, top = 10) {
  const t = Math.max(1, Math.min(50, Number(top) || 10));
  return await graphGet(
    `/me/messages?$top=${t}&$select=id,subject,receivedDateTime,from,isRead,bodyPreview&$orderby=receivedDateTime desc`,
    accessToken,
  );
}

export async function listSentMail(accessToken, top = 10) {
  const t = Math.max(1, Math.min(50, Number(top) || 10));
  return await graphGet(
    `/me/mailFolders/sentitems/messages?$top=${t}&$select=id,subject,receivedDateTime,toRecipients,isRead,bodyPreview&$orderby=receivedDateTime desc`,
    accessToken,
  );
}

export async function getMail(accessToken, messageId) {
  return await graphGet(
    `/me/messages/${messageId}?$select=id,subject,receivedDateTime,from,isRead,body`,
    accessToken,
  );
}

export async function sendMail(accessToken, { to, cc, bcc, subject, bodyText, bodyHtml, attachments, saveToSentItems = true }) {
  if (!to) throw new Error("Missing 'to'");
  const toRecipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } }));
  const ccRecipients = cc ? (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } })) : [];
  const bccRecipients = bcc ? (Array.isArray(bcc) ? bcc : [bcc]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } })) : [];

  const message = {
    subject: subject || "",
    body: bodyHtml
      ? { contentType: "HTML", content: bodyHtml }
      : { contentType: "Text", content: bodyText || "" },
    toRecipients,
    ccRecipients,
    bccRecipients,
  };

  // Add attachments if provided
  // attachments should be array of { name, contentType, contentBytes (base64) }
  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map(att => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.name,
      contentType: att.contentType,
      contentBytes: att.contentBytes, // Must be base64 encoded
    }));
  }

  const payload = {
    message,
    saveToSentItems,
  };

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  // sendMail returns 202 w/ empty body on success
  if (res.status === 202) return { accepted: true };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `sendMail failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

export async function deleteMail(accessToken, messageId) {
  const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  // 204 No Content is the expected success response for DELETE
  if (res.status === 204) return { deleted: true };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `deleteMail failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

// ==================== MAIL FOLDERS ====================

export async function listMailFolders(accessToken) {
  return await graphGet("/me/mailFolders?$top=100", accessToken);
}

export async function getMailFolder(accessToken, folderId) {
  return await graphGet(`/me/mailFolders/${folderId}`, accessToken);
}

export async function listMailInFolder(accessToken, folderId, top = 25) {
  const t = Math.max(1, Math.min(100, Number(top) || 25));
  return await graphGet(
    `/me/mailFolders/${folderId}/messages?$top=${t}&$select=id,subject,receivedDateTime,from,toRecipients,isRead,bodyPreview,hasAttachments,importance,flag&$orderby=receivedDateTime desc`,
    accessToken,
  );
}

// ==================== DRAFTS ====================

export async function listDrafts(accessToken, top = 25) {
  const t = Math.max(1, Math.min(100, Number(top) || 25));
  return await graphGet(
    `/me/mailFolders/drafts/messages?$top=${t}&$select=id,subject,createdDateTime,toRecipients,body,bodyPreview,hasAttachments&$orderby=createdDateTime desc`,
    accessToken,
  );
}

export async function createDraft(accessToken, { to, cc, bcc, subject, bodyText, bodyHtml }) {
  const toRecipients = to ? (Array.isArray(to) ? to : [to]).map(addr => ({ emailAddress: { address: addr } })) : [];
  const ccRecipients = cc ? (Array.isArray(cc) ? cc : [cc]).map(addr => ({ emailAddress: { address: addr } })) : [];
  const bccRecipients = bcc ? (Array.isArray(bcc) ? bcc : [bcc]).map(addr => ({ emailAddress: { address: addr } })) : [];

  const payload = {
    subject: subject || "",
    body: bodyHtml
      ? { contentType: "HTML", content: bodyHtml }
      : { contentType: "Text", content: bodyText || "" },
    toRecipients,
    ccRecipients,
    bccRecipients,
  };

  return await graphPost("/me/messages", accessToken, payload);
}

export async function updateDraft(accessToken, messageId, { to, cc, bcc, subject, bodyText, bodyHtml }) {
  const payload = {};
  if (subject !== undefined) payload.subject = subject;
  if (bodyText !== undefined || bodyHtml !== undefined) {
    payload.body = bodyHtml
      ? { contentType: "HTML", content: bodyHtml }
      : { contentType: "Text", content: bodyText || "" };
  }
  if (to !== undefined) {
    payload.toRecipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } }));
  }
  if (cc !== undefined) {
    payload.ccRecipients = (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } }));
  }
  if (bcc !== undefined) {
    payload.bccRecipients = (Array.isArray(bcc) ? bcc : [bcc]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } }));
  }

  return await graphPatch(`/me/messages/${messageId}`, accessToken, payload);
}

export async function sendDraft(accessToken, messageId) {
  return await graphPost(`/me/messages/${messageId}/send`, accessToken, {});
}

// ==================== MESSAGE ACTIONS ====================

export async function markAsRead(accessToken, messageId, isRead = true) {
  return await graphPatch(`/me/messages/${messageId}`, accessToken, { isRead });
}

export async function moveMessage(accessToken, messageId, destinationFolderId) {
  return await graphPost(`/me/messages/${messageId}/move`, accessToken, { destinationId: destinationFolderId });
}

export async function copyMessage(accessToken, messageId, destinationFolderId) {
  return await graphPost(`/me/messages/${messageId}/copy`, accessToken, { destinationId: destinationFolderId });
}

export async function replyToMessage(accessToken, messageId, { comment }) {
  return await graphPost(`/me/messages/${messageId}/reply`, accessToken, { comment: comment || "" });
}

export async function replyAllToMessage(accessToken, messageId, { comment }) {
  return await graphPost(`/me/messages/${messageId}/replyAll`, accessToken, { comment: comment || "" });
}

export async function forwardMessage(accessToken, messageId, { to, comment }) {
  const toRecipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(addr => ({ emailAddress: { address: addr } }));
  return await graphPost(`/me/messages/${messageId}/forward`, accessToken, { comment: comment || "", toRecipients });
}

export async function flagMessage(accessToken, messageId, flagStatus = "flagged") {
  // flagStatus: "notFlagged", "flagged", "complete"
  return await graphPatch(`/me/messages/${messageId}`, accessToken, { flag: { flagStatus } });
}

// ==================== ATTACHMENTS ====================

export async function listAttachments(accessToken, messageId) {
  return await graphGet(`/me/messages/${messageId}/attachments`, accessToken);
}

export async function getAttachment(accessToken, messageId, attachmentId) {
  return await graphGet(`/me/messages/${messageId}/attachments/${attachmentId}`, accessToken);
}

// ==================== SEARCH ====================

export async function searchMail(accessToken, query, top = 25) {
  const t = Math.max(1, Math.min(100, Number(top) || 25));
  const searchQuery = encodeURIComponent(query);
  return await graphGet(
    `/me/messages?$search="${searchQuery}"&$top=${t}&$select=id,subject,receivedDateTime,from,toRecipients,isRead,bodyPreview,hasAttachments`,
    accessToken,
  );
}

// ==================== MAILBOX SETTINGS ====================

export async function getMailboxSettings(accessToken) {
  return await graphGet("/me/mailboxSettings", accessToken);
}

export async function updateAutoReply(accessToken, { enabled, externalMessage, internalMessage, startTime, endTime }) {
  const automaticRepliesSetting = {
    status: enabled ? "scheduled" : "disabled",
    externalReplyMessage: externalMessage || "",
    internalReplyMessage: internalMessage || "",
  };
  if (startTime) automaticRepliesSetting.scheduledStartDateTime = { dateTime: startTime, timeZone: "UTC" };
  if (endTime) automaticRepliesSetting.scheduledEndDateTime = { dateTime: endTime, timeZone: "UTC" };

  return await graphPatch("/me/mailboxSettings", accessToken, { automaticRepliesSetting });
}


