import { getAccessToken, searchMessages, getMessage, ensureLabel, addLabels, threadLink, getThreadLabelIds } from "../lib/gmail.js";
import { decideRecipient } from "../lib/router.js";
import { sendTelegramNotification, listContacts } from "../lib/telegram.js";

const CRON_SECRET = process.env.CRON_SECRET;
const ROUTED_LABEL = "Routed";
const NEEDS_REVIEW_LABEL = "Needs Review";
// How far back to look for unrouted mail. A buffer beyond the 20-minute
// schedule in case a run is delayed or missed — not meant to reach back
// into old backlog. Override with GMAIL_LOOKBACK_DAYS if needed.
const LOOKBACK_DAYS = process.env.GMAIL_LOOKBACK_DAYS || "2";
// Customize this to match how your shared inbox is organized — e.g. only
// look at a specific label instead of the whole inbox. If you override
// this directly, remember to include your own "newer_than" bound too.
const SEARCH_QUERY =
  process.env.GMAIL_SEARCH_QUERY ||
  `in:inbox -label:${ROUTED_LABEL.replace(/\s/g, "-")} newer_than:${LOOKBACK_DAYS}d`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const { contacts } = listContacts();
  const contactNames = Object.keys(contacts);

  if (contactNames.length === 0) {
    return res.status(500).json({ error: "No contacts configured in TELEGRAM_CONTACTS_JSON." });
  }

  const results = { processed: 0, routed: [], needsReview: [], errors: [] };

  try {
    const accessToken = await getAccessToken();
    const labelCache = {};

    // Pre-create all labels we might need up front.
    const routedLabelId = await ensureLabel(accessToken, ROUTED_LABEL, labelCache);
    const needsReviewLabelId = await ensureLabel(accessToken, NEEDS_REVIEW_LABEL, labelCache);
    const perContactLabelIds = {};
    const labelIdToContact = {};
    for (const name of contactNames) {
      const id = await ensureLabel(accessToken, `Assigned/${name}`, labelCache);
      perContactLabelIds[name] = id;
      labelIdToContact[id] = name;
    }

    const stubs = await searchMessages(accessToken, SEARCH_QUERY, 25);
    results.processed = stubs.length;

    for (const stub of stubs) {
      try {
        const msg = await getMessage(accessToken, stub.id);

        // Gmail labels apply per-message, not per-thread — so a reply to
        // an already-assigned thread arrives unlabeled. Check the rest of
        // the thread first: if it was already assigned, this new message
        // (a fresh reply, a forwarded update, etc.) belongs to the same
        // person even if their name isn't repeated in this message.
        const threadLabelIds = await getThreadLabelIds(accessToken, msg.threadId);
        const inheritedContact = Object.keys(labelIdToContact)
          .filter((id) => threadLabelIds.has(id))
          .map((id) => labelIdToContact[id])[0];

        const decision = inheritedContact
          ? { contact: inheritedContact, confidence: "high", reason: "New activity on a thread already assigned to them." }
          : await decideRecipient({
              subject: msg.subject,
              from: msg.from,
              bodyText: msg.bodyText,
              contactNames,
            });

        if (decision.contact && decision.confidence === "high") {
          await addLabels(accessToken, msg.id, [routedLabelId, perContactLabelIds[decision.contact]]);

          const link = threadLink(msg.threadId);
          const summary = inheritedContact
            ? `New reply from ${msg.from} on "${msg.subject}". ${link}`
            : `New sales email from ${msg.from}: "${msg.subject}". ${decision.reason} ${link}`;
          const sent = await sendTelegramNotification({ contact: decision.contact, message: summary });

          results.routed.push({
            id: msg.id,
            subject: msg.subject,
            contact: decision.contact,
            inherited: Boolean(inheritedContact),
            notified: sent.ok,
            notifyError: sent.ok ? undefined : sent.error,
          });
        } else {
          await addLabels(accessToken, msg.id, [routedLabelId, needsReviewLabelId]);
          results.needsReview.push({ id: msg.id, subject: msg.subject, reason: decision.reason });
        }
      } catch (err) {
        results.errors.push({ id: stub.id, error: String(err.message || err) });
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err), partial: results });
  }
}
