// Local / traditional-host entry point (Render, Railway, Fly.io, etc).
// Not used by Vercel — Vercel invokes api/index.js directly instead.
import app from "./app.js";

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Telegram MCP server listening on port ${PORT}`);
});
