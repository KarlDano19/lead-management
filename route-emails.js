import { getAccessToken, searchMessages, getMessage, ensureLabel, addLabels, threadLink } from "../lib/gmail.js";
import { decideRecipient } from "../lib/router.js";
import { sendTelegramNotification, listContacts } from "../lib/telegram.js";

const CRON_SECRET = process.env.CRON_SECRET;
const ROUTED_LABEL = "Routed";
const NEEDS_REVIEW_LABEL = "Needs Review";
// Customize this to match how your shared inbox is organized — e.g. only
// look at a specific label instead of the whole inbox.
const SEARCH_QUERY = process.env.GMAIL_SEARCH_QUERY || `in:inbox -label:${ROUTED_LABEL.replace(/\s/g, "-")}`;

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
    for (const name of contactNames) {
      perContactLabelIds[name] = await ensureLabel(accessToken, `Assigned/${name}`, labelCache);
    }

    const stubs = await searchMessages(accessToken, SEARCH_QUERY, 25);
    results.processed = stubs.length;

    for (const stub of stubs) {
      try {
        const msg = await getMessage(accessToken, stub.id);
        const decision = await decideRecipient({
          subject: msg.subject,
          from: msg.from,
          bodyText: msg.bodyText,
          contactNames,
        });

        if (decision.contact && decision.confidence === "high") {
          await addLabels(accessToken, msg.id, [routedLabelId, perContactLabelIds[decision.contact]]);

          const link = threadLink(msg.threadId);
          const summary = `New sales email from ${msg.from}: "${msg.subject}". ${decision.reason} ${link}`;
          const sent = await sendTelegramNotification({ contact: decision.contact, message: summary });

          results.routed.push({
            id: msg.id,
            subject: msg.subject,
            contact: decision.contact,
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
