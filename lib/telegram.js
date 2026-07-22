const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || "";
const CONTACTS = JSON.parse(process.env.TELEGRAM_CONTACTS_JSON || "{}");

/**
 * Sends a Telegram notification for a given contact name.
 * Group mode (TELEGRAM_GROUP_CHAT_ID set): posts to the group and
 * @mentions the contact's username.
 * DM mode (unset): messages the contact's chat_id directly.
 *
 * Returns { ok: true } or { ok: false, error }.
 */
export async function sendTelegramNotification({ contact, chatId, message }) {
  if (!BOT_TOKEN) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN env var." };
  }

  let targetChatId;
  let text = message;

  if (GROUP_CHAT_ID) {
    targetChatId = chatId || GROUP_CHAT_ID;
    if (contact && CONTACTS[contact] && !chatId) {
      text = `@${CONTACTS[contact]} ${message}`;
    } else if (contact && !CONTACTS[contact]) {
      return {
        ok: false,
        error: `Unknown contact "${contact}". Known: ${Object.keys(CONTACTS).join(", ") || "(none configured)"}`,
      };
    }
  } else {
    targetChatId = chatId || (contact ? CONTACTS[contact] : undefined);
    if (!targetChatId) {
      return {
        ok: false,
        error: `Could not resolve a chat_id. Known contacts: ${Object.keys(CONTACTS).join(", ") || "(none configured)"}`,
      };
    }
  }

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetChatId, text }),
  });

  const data = await resp.json();
  if (!data.ok) {
    return { ok: false, error: `Telegram API error: ${JSON.stringify(data)}` };
  }
  return { ok: true };
}

export function listContacts() {
  return { mode: GROUP_CHAT_ID ? "group (@mention)" : "direct message", contacts: CONTACTS };
}
