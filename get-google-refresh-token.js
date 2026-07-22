// One-time helper: run this LOCALLY (not on Vercel) to get a Gmail OAuth
// refresh token for the shared sales inbox account. Run once, copy the
// printed refresh token into your Vercel env vars, then you never need
// this script again.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-google-refresh-token.js
//
// Requires a Google Cloud OAuth "Desktop app" client ID/secret with the
// Gmail API enabled. See README.md for how to create one.

import http from "node:http";
import { URL } from "node:url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
// Forces Google to issue a refresh token even if this account has
// authorized this app before.
authUrl.searchParams.set("prompt", "consent");

console.log("\n1. Make sure you're signed in (in your browser) as the SHARED SALES INBOX account, not your personal one.");
console.log("2. Open this URL and approve access:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth/callback") {
    res.writeHead(404);
    return res.end();
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Google returned an error: ${error}. Check the terminal and try again.`);
    console.error("OAuth error:", error);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Success — you can close this tab and go back to the terminal.");

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenResp.json();

    if (!tokenResp.ok) {
      console.error("Token exchange failed:", tokenData);
      process.exit(1);
    }

    if (!tokenData.refresh_token) {
      console.error(
        "\nNo refresh_token in the response. This usually means this account already " +
          "granted access before. Go to https://myaccount.google.com/permissions, remove " +
          "access for this app, and run this script again.\n"
      );
      process.exit(1);
    }

    console.log("\nSuccess! Add these to your Vercel project's environment variables:\n");
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokenData.refresh_token}`);
    console.log("");
  } catch (err) {
    console.error("Error exchanging code for tokens:", err);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
