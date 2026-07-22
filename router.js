const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Cheap, fast model — this is a simple classification task running every
// 20 minutes, no need for a heavier model here.
const MODEL = process.env.ANTHROPIC_ROUTER_MODEL || "claude-haiku-4-5-20251001";

/**
 * Reads an email and decides which known contact it's for.
 * Returns { contact: "<name>"|null, confidence: "high"|"low", reason: string }.
 * contact is null (and confidence "low") when the model isn't confident —
 * the caller should route that to a "Needs Review" label instead of guessing.
 */
export async function decideRecipient({ subject, from, bodyText, contactNames }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY env var.");
  }

  const system = `You triage incoming sales emails for a shared inbox. Given an email, decide which team member it is intended for, based on any name mentioned in the email content (e.g. "please have Maria follow up", "Attn: Josh", a name in a signature reference, etc).

Known team members: ${contactNames.join(", ")}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"contact": "<one of the known team members, or null if unclear>", "confidence": "high" or "low", "reason": "<one short sentence>"}

If no team member is clearly indicated, or the mention is ambiguous between two people, return contact: null and confidence: "low". Do not guess.`;

  const userMessage = `Subject: ${subject}\nFrom: ${from}\n\nBody:\n${bodyText}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Anthropic API error: ${JSON.stringify(data)}`);
  }

  const raw = data.content?.find((b) => b.type === "text")?.text || "{}";

  let parsed;
  try {
    // Model is instructed to return only JSON, but strip code fences just in case.
    const cleaned = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { contact: null, confidence: "low", reason: "Could not parse routing response." };
  }

  if (!contactNames.includes(parsed.contact)) {
    parsed.contact = null;
    parsed.confidence = "low";
  }

  return parsed;
}
