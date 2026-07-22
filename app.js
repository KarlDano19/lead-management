import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { sendTelegramNotification, listContacts } from "./lib/telegram.js";

const SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional bearer token Cowork must send

// This MCP endpoint is now optional — the automated pipeline (api/route-emails.js,
// triggered by GitHub Actions) sends Telegram notifications directly without
// going through MCP. Keep this around if you still want to manually ask
// Claude (Cowork, Claude Code, etc.) to send an ad-hoc Telegram notification.

function buildServer() {
  const server = new McpServer({ name: "telegram-notify", version: "1.2.0" });

  server.registerTool(
    "list_contacts",
    {
      title: "List Telegram contacts",
      description:
        "Lists the team member names this server can notify, and whether it's running in group (@mention) or direct-message mode.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listContacts(), null, 2) }],
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
      const result = await sendTelegramNotification({ contact, chatId: chat_id, message });
      if (!result.ok) {
        return { isError: true, content: [{ type: "text", text: result.error }] };
      }
      return { content: [{ type: "text", text: `Sent to ${contact || chat_id}.` }] };
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
