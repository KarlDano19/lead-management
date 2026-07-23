const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Exchanges the stored refresh token for a fresh access token.
 * Access tokens expire in ~1hr, so each cron run just gets a new one —
 * simplest option for a stateless serverless function.
 */
export async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env vars.");
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Failed to refresh Google access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function gmailFetch(accessToken, path, options = {}) {
  const resp = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Gmail API error on ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Searches for messages matching a Gmail search query, e.g.
 * "in:inbox -label:Routed". Returns up to `maxResults` message stubs
 * ({ id, threadId }) — call getMessage() for full content.
 */
export async function searchMessages(accessToken, query, maxResults = 25) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await gmailFetch(accessToken, `/messages?${params.toString()}`);
  return data.messages || [];
}

function decodeBase64Url(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  // Fall back to HTML part, stripped, if no plain-text part exists.
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, " ");
  }
  return "";
}

function getHeader(headers, name) {
  const h = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

/**
 * Fetches a single message and returns the fields the router needs:
 * subject, from, a trimmed plain-text body, and the thread ID (for
 * building a Gmail deep link).
 */
export async function getMessage(accessToken, messageId) {
  const data = await gmailFetch(accessToken, `/messages/${messageId}?format=full`);
  const subject = getHeader(data.payload?.headers, "Subject");
  const from = getHeader(data.payload?.headers, "From");
  const bodyText = (extractPlainText(data.payload) || data.snippet || "").slice(0, 6000);

  return {
    id: data.id,
    threadId: data.threadId,
    subject,
    from,
    bodyText,
    snippet: data.snippet,
  };
}

/**
 * Looks up a label by name, creating it if it doesn't exist yet.
 * Returns the label ID. Pass a cache object across calls in the same
 * run to avoid refetching the label list every time.
 */
export async function ensureLabel(accessToken, name, cache = {}) {
  if (cache[name]) return cache[name];

  if (!cache.__all) {
    const data = await gmailFetch(accessToken, "/labels");
    cache.__all = data.labels || [];
  }

  const existing = cache.__all.find((l) => l.name === name);
  if (existing) {
    cache[name] = existing.id;
    return existing.id;
  }

  const created = await gmailFetch(accessToken, "/labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  cache[name] = created.id;
  cache.__all.push(created);
  return created.id;
}

/**
 * Adds label IDs to a message (e.g. ["Routed", "Assigned/Maria"] resolved
 * to their label IDs via ensureLabel first).
 */
export async function addLabels(accessToken, messageId, labelIds) {
  await gmailFetch(accessToken, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: labelIds }),
  });
}

export function threadLink(threadId) {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

/**
 * Returns the set of label IDs present anywhere in a thread (across all
 * its messages, not just the one currently being processed). Used to
 * detect "this thread was already assigned to someone" so a new reply
 * that doesn't repeat their name can still be routed to them correctly.
 */
export async function getThreadLabelIds(accessToken, threadId) {
  const data = await gmailFetch(accessToken, `/threads/${threadId}?format=minimal`);
  const labelIds = new Set();
  for (const msg of data.messages || []) {
    for (const id of msg.labelIds || []) labelIds.add(id);
  }
  return labelIds;
}
