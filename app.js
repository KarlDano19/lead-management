import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional bearer token Cowork must send

// GROUP MODE (recommended for a shared inbox): set TELEGRAM_GROUP_CHAT_ID.
// All notifications post to that one group; CONTACTS maps name -> Telegram
// @username (no "@"), which gets mentioned in the message so that person
// still gets a personal ping.
//
// DM MODE (fallback): leave TELEGRAM_GROUP_CHAT_ID unset. CONTACTS instead
// maps name -> that person's individual chat_id, and each message goes
// straight to their DM. Requires each person to have messaged the bot once.
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || "";
const CONTACTS = JSON.parse(process.env.TELEGRAM_CONTACTS_JSON || "{}");

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
}

function buildServer() {
  const server = new McpServer({ name: "telegram-notify", version: "1.1.0" });

  server.registerTool(
    "list_contacts",
    {
      title: "List Telegram contacts",
      description:
        "Lists the team member names this server can notify, and whether it's running in group (@mention) or direct-message mode.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              mode: GROUP_CHAT_ID ? "group (@mention)" : "direct message",
              contacts: CONTACTS,
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerTool(
    "send_telegram_message",
    {
      title: "Send Telegram message",
      description:
        "Notifies a team member on Telegram. Provide 'contact' (a name from list_contacts). In group mode this posts to the shared group and @mentions them; in DM mode it messages them privately.",
      inputSchema: {
        contact: z
          .string()
          .optional()
          .describe("Team member name as configured in TELEGRAM_CONTACTS_JSON, e.g. 'Maria'"),
        chat_id: z
          .string()
          .optional()
          .describe("Raw Telegram chat ID override, used instead of 'contact' resolution"),
        message: z.string().describe("The message text to send"),
      },
    },
    async ({ contact, chat_id, message }) => {
      let targetChatId;
      let text = message;

      if (GROUP_CHAT_ID) {
        targetChatId = chat_id || GROUP_CHAT_ID;
        if (contact && CONTACTS[contact] && !chat_id) {
          text = `@${CONTACTS[contact]} ${message}`;
        } else if (contact && !CONTACTS[contact]) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown contact "${contact}". Known: ${Object.keys(CONTACTS).join(", ") || "(none configured)"}`,
              },
            ],
          };
        }
      } else {
        targetChatId = chat_id || (contact ? CONTACTS[contact] : undefined);
        if (!targetChatId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not resolve a chat_id. Known contacts: ${Object.keys(CONTACTS).join(", ") || "(none configured)"}`,
              },
            ],
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
        return {
          isError: true,
          content: [{ type: "text", text: `Telegram API error: ${JSON.stringify(data)}` }],
        };
      }

      return {
        content: [{ type: "text", text: `Sent (${GROUP_CHAT_ID ? "group mention" : "DM"}) to ${contact || targetChatId}.` }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Simple bearer-token check so random internet traffic can't use your bot.
app.use((req, res, next) => {
  if (!SHARED_SECRET) return next(); // no secret configured = open (fine for quick testing only)
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${SHARED_SECRET}`) return next();
  res.status(401).json({ error: "unauthorized" });
});

// Stateless mode: a fresh transport+server per request. Works locally and
// on serverless hosts (Vercel, etc.) since there's no session to persist
// between calls.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error" });
    }
  }
});

app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});

app.get("/healthz", (req, res) => res.send("ok"));

export default app;
