// Vercel serverless entry point. Vercel auto-detects any file under /api
// and treats its default export as the request handler — an Express app
// works directly since it's just a (req, res) function under the hood.
import app from "../app.js";

export default app;
