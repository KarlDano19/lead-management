// Quick smoke test: stubs global fetch to simulate Gmail, Anthropic, and
// Telegram responses, then runs the actual handler and checks the result
// shape. Not a permanent part of the project — just verifying the wiring
// before handoff. Run with: node test/mock-route-emails.test.js
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_GROUP_CHAT_ID = "-100123456";
process.env.TELEGRAM_CONTACTS_JSON = JSON.stringify({ Maria: "maria_sales", Josh: "joshdano" });
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.CRON_SECRET = "test-cron-secret";

const realFetch = global.fetch;

function b64url(str) {
  return Buffer.from(str, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const FAKE_LABELS = { labels: [{ id: "LBL_INBOX", name: "INBOX" }] };
const FAKE_MESSAGE_LIST = { messages: [{ id: "msg1", threadId: "thread1" }] };
const FAKE_MESSAGE_FULL = {
  id: "msg1",
  threadId: "thread1",
  snippet: "Hi, can Maria follow up on this quote?",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: "Quote request" },
      { name: "From", value: "customer@example.com" },
    ],
    body: { data: b64url("Hi, can Maria follow up on this quote request? Thanks!") },
  },
};

let calls = [];

global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || "GET" });

  // Google OAuth token refresh
  if (url.includes("oauth2.googleapis.com/token")) {
    return jsonResponse({ access_token: "fake-access-token", expires_in: 3600 });
  }
  // Gmail: list labels
  if (url.includes("/labels") && (!opts.method || opts.method === "GET")) {
    return jsonResponse(FAKE_LABELS);
  }
  // Gmail: create label
  if (url.includes("/labels") && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    const id = "LBL_" + body.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    FAKE_LABELS.labels.push({ id, name: body.name });
    return jsonResponse({ id, name: body.name });
  }
  // Gmail: search messages
  if (url.includes("/messages?")) {
    return jsonResponse(FAKE_MESSAGE_LIST);
  }
  // Gmail: get message
  if (url.includes("/messages/msg1?")) {
    return jsonResponse(FAKE_MESSAGE_FULL);
  }
  // Gmail: modify labels
  if (url.includes("/messages/msg1/modify")) {
    return jsonResponse({ id: "msg1" });
  }
  // Anthropic routing decision
  if (url.includes("api.anthropic.com")) {
    return jsonResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({ contact: "Maria", confidence: "high", reason: "Email explicitly asks for Maria." }),
        },
      ],
    });
  }
  // Telegram send
  if (url.includes("api.telegram.org")) {
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  }

  throw new Error("Unmocked fetch call: " + url);
};

function jsonResponse(obj, ok = true) {
  return {
    ok,
    json: async () => obj,
  };
}

const { default: handler } = await import("../api/route-emails.js");

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

const req = {
  method: "POST",
  headers: { authorization: "Bearer test-cron-secret" },
};
const res = makeRes();

await handler(req, res);

console.log("Status:", res.statusCode);
console.log("Body:", JSON.stringify(res.body, null, 2));

const assertions = [
  ["status is 200", res.statusCode === 200],
  ["processed 1 message", res.body?.processed === 1],
  ["routed to Maria", res.body?.routed?.[0]?.contact === "Maria"],
  ["notified true", res.body?.routed?.[0]?.notified === true],
  ["no errors", (res.body?.errors || []).length === 0],
  ["label created for Assigned/Maria", calls.some((c) => c.url.includes("/labels") && c.method === "POST")],
  ["telegram was called", calls.some((c) => c.url.includes("api.telegram.org"))],
];

let allPassed = true;
for (const [desc, passed] of assertions) {
  console.log(`${passed ? "PASS" : "FAIL"}: ${desc}`);
  if (!passed) allPassed = false;
}

global.fetch = realFetch;
process.exit(allPassed ? 0 : 1);
