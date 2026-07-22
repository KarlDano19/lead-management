# Sales Inbox Auto-Router

Reads a shared Gmail sales inbox every 20 minutes, figures out which team
member each new email is for (based on freeform name mentions, via Claude),
labels it, and pings the right person in a Telegram group. Fully
self-contained — runs on Vercel + GitHub Actions, no Claude Cowork or
Claude Code required, and nothing depends on your computer being on.

## How it works

```
GitHub Actions (every 20 min, free)
        |
        v  POST (with a shared secret)
Vercel: /api/route-emails
        |
        |-- Gmail API: search inbox for emails without a "Routed" label
        |-- for each: Anthropic API decides who it's for (freeform reading)
        |-- Gmail API: label it "Routed" + "Assigned/<name>" (or "Needs Review")
        |-- Telegram API: post to the shared group, @mention that person
        v
Team member sees the ping, taps the thread link, handles it
```

`/api/mcp` (the original Telegram-notify MCP server) is still there too —
optional now, useful only if you want to manually ask Claude (Cowork,
Claude Code, etc.) to fire off an ad-hoc Telegram message outside the
automated flow.

## 1. Google Cloud setup (for Gmail access)

This needs a one-time OAuth setup since there's no human around to click
"log in with Google" every 20 minutes.

1. Go to [console.cloud.google.com](https://console.cloud.google.com),
   create a project (or use an existing one).
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → set it up (External is
   fine; you can leave it in "Testing" mode, which allows up to 100 test
   users — just add the sales inbox's Google account as a test user).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type: **Desktop app**. Save the Client ID and Client
   Secret.
5. On your own machine (not Vercel), with Node installed, run:
   ```
   GOOGLE_CLIENT_ID=<from step 4> GOOGLE_CLIENT_SECRET=<from step 4> \
     node scripts/get-google-refresh-token.js
   ```
   Open the printed URL, **sign in as the shared sales inbox account**
   (not your personal one) when prompted, and approve access. The script
   prints a `GOOGLE_REFRESH_TOKEN` — save all three values, you'll need
   them in step 3 below.

## 2. Anthropic API key (for the routing decision)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com).
2. This runs frequently but the model (Haiku) is cheap and each call is
   small — cost at this volume should be a few dollars a month at most,
   but keep an eye on usage the first week.

## 3. Deploy to Vercel

1. `vercel` from this project folder (or import the repo via the Vercel
   dashboard).
2. Project Settings → Environment Variables, add:

   | Variable | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | your bot's token |
   | `TELEGRAM_GROUP_CHAT_ID` | your group's chat ID (see earlier setup) |
   | `TELEGRAM_CONTACTS_JSON` | `{"Maria":"maria_sales","Josh":"joshdano"}` — names to Telegram usernames |
   | `GOOGLE_CLIENT_ID` | from step 1.4 |
   | `GOOGLE_CLIENT_SECRET` | from step 1.4 |
   | `GOOGLE_REFRESH_TOKEN` | from step 1.5 |
   | `ANTHROPIC_API_KEY` | from step 2 |
   | `CRON_SECRET` | any random string you make up — GitHub Actions will send this |
   | `MCP_SHARED_SECRET` | optional, only if you're still using the `/api/mcp` endpoint too |

3. Redeploy so the vars take effect: `vercel --prod`
4. Your routing endpoint: `https://<your-project>.vercel.app/api/route-emails`

## 4. Wire up GitHub Actions (the free scheduler)

The workflow file is already at
`.github/workflows/route-sales-emails.yml` — it runs every 20 minutes and
just calls your endpoint.

1. Push this project to a GitHub repo.
2. In the repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Add:
   - `ROUTE_EMAILS_URL` = `https://<your-project>.vercel.app/api/route-emails`
   - `CRON_SECRET` = the same value you set on Vercel
3. That's it — GitHub will start running it on schedule. You can also
   trigger a run manually anytime from the repo's **Actions** tab (the
   `workflow_dispatch` trigger).

## Customizing

- **Which emails count as "unrouted"**: controlled by the
  `GMAIL_SEARCH_QUERY` env var (defaults to `in:inbox -label:Routed`).
  Point it at a specific label if your sales inbox isn't the whole inbox,
  e.g. `label:sales -label:Routed`.
- **Team members**: just edit `TELEGRAM_CONTACTS_JSON` on Vercel and
  redeploy — no code changes.
- **Confidence threshold**: right now anything not "high confidence" goes
  to "Needs Review" rather than guessing. That logic lives in
  `api/route-emails.js` if you want to tune it.

## Testing before going live

`test/mock-route-emails.test.js` runs the full pipeline against fake
Gmail/Anthropic/Telegram responses (no real credentials needed) — useful
to confirm the code itself works before wiring up real accounts:

```
node test/mock-route-emails.test.js
```

## Notes / limitations

- Runs on a 20-minute clock, not instantly on arrival — there's no
  Gmail push-notification trigger in this setup.
- If your Google Cloud OAuth consent screen stays in "Testing" mode,
  Google may periodically ask you to re-confirm the test user list, but
  the refresh token itself doesn't expire from that.
- The Telegram bot can only @mention people with a public username set,
  and only if they haven't muted the group.
- Each run processes up to 25 unrouted emails; if a backlog is larger
  than that, it'll finish clearing it over a few 20-minute cycles rather
  than all at once.
