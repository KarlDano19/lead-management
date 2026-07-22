# Telegram MCP Server — Sales Inbox Notifier

A small remote MCP server with two tools:

- `list_contacts` — shows the team-member names it knows how to notify
- `send_telegram_message` — notifies a team member on Telegram

Built so a Claude Cowork scheduled task can call it after reading a sales
email, to actually ping the right person — since Cowork can't send Gmail
mail directly.

Supports two modes, controlled entirely by env vars (no code changes):

- **Group mode (recommended)** — one shared Telegram group. The bot posts
  there and `@mentions` the right person, so they still get a personal
  ping, while the rest of the team has visibility too. Set
  `TELEGRAM_GROUP_CHAT_ID`.
- **DM mode** — private 1:1 messages per person. Leave
  `TELEGRAM_GROUP_CHAT_ID` unset. Requires each person to have messaged the
  bot once first (a Telegram platform requirement, not something this code
  can work around).

## 1. Create your Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts,
   and copy the **bot token** it gives you (looks like
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).

### If using group mode
2. Create a Telegram group with your team, add the bot to it.
3. Have anyone send a message in the group that @mentions the bot (e.g.
   `@yourbot hi`) — bots don't see regular group messages by default, only
   ones addressed to them, unless you disable privacy mode via
   `/setprivacy` in @BotFather.
4. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   right after. Find `"chat":{"id":-100xxxxxxxxxx, ...}` — group chat IDs
   are negative numbers. That's your `TELEGRAM_GROUP_CHAT_ID`.
5. For `TELEGRAM_CONTACTS_JSON`, map each name to that person's Telegram
   **@username** (no "@", must be a public username they've set in
   Telegram settings), e.g. `{"Maria":"maria_sales","Josh":"joshdano"}`.

### If using DM mode instead
2. Have each team member message the bot once (required before it can DM
   them).
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` right after
   each message and note their `chat.id` (positive number, personal chats).
4. For `TELEGRAM_CONTACTS_JSON`, map each name to their numeric chat ID,
   e.g. `{"Maria":"111111","Josh":"222222"}`.
5. Leave `TELEGRAM_GROUP_CHAT_ID` unset.

## 2. Environment variables

| Variable | Group mode example | DM mode example |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456789:AAExxxx...` | same |
| `TELEGRAM_GROUP_CHAT_ID` | `-1001234567890` | *(leave unset)* |
| `TELEGRAM_CONTACTS_JSON` | `{"Maria":"maria_sales"}` (usernames) | `{"Maria":"111111"}` (chat IDs) |
| `MCP_SHARED_SECRET` | any random string — recommended | same |

## 3. Deploy it somewhere with a public HTTPS URL

Cowork connects to custom connectors from Anthropic's cloud, not from your
own machine — so this needs a public internet address, not localhost.

### Option A: Vercel
The server's stateless design (fresh MCP transport per request, no session
to persist) maps cleanly onto Vercel's serverless model, so no extra work
was needed beyond how the project is already structured:

- `api/index.js` — the Vercel entry point (exports the Express app)
- `vercel.json` — routes all paths to that function so `/mcp` and
  `/healthz` still work as expected

Steps:
1. `vercel` (or connect the repo in the Vercel dashboard) from this folder.
2. In Project Settings → Environment Variables, add the vars from step 2.
3. Deploy. Your MCP endpoint is `https://<your-project>.vercel.app/mcp`.

Note: Vercel's default function timeout (10s on the Hobby plan) is more
than enough for a single Telegram API call, so this isn't a practical
concern at this volume — worth knowing about only if you ever expand this
server to do heavier work.

### Option B: Render / Railway / Fly.io
These run the server as a normal always-on Node process via `server.js`
(`npm start`) — no code differences, just point the platform at this
folder and set the same env vars.

## 4. Add it to Cowork as a custom connector

1. In Claude Desktop: **Settings → Connectors → Add custom connector**.
2. Paste your server URL: `https://<your-app-domain>/mcp`
3. Under "Advanced settings," add a request header:
   `Authorization: Bearer <your MCP_SHARED_SECRET>`
4. Save, then enable it for your Cowork session.

## 5. Set up the scheduled task in Cowork

Use `/schedule` (or the Schedule tab) with a prompt along these lines —
fill in your real team names to match `TELEGRAM_CONTACTS_JSON`:

> Every 20 minutes: search Gmail for sales inbox emails that don't have a
> "Routed" label. For each one, read it and determine which team member it's
> for — Maria, Josh, or [others] — based on the name mentioned in the email
> (use `list_contacts` if unsure who's available). Apply a Gmail label with
> that person's name, apply the "Routed" label, then call
> `send_telegram_message` with that contact and a message containing: a
> two-sentence summary of the email, the sender, and a direct link to the
> thread in the form `https://mail.google.com/mail/u/0/#all/<threadId>`
> (use the thread's ID from the Gmail search/read results). If you can't
> confidently tell who it's for, label it "Needs Review" and don't send a
> Telegram message.

## Notes / limitations

- DM mode: Telegram bots cannot initiate a DM to someone who hasn't
  messaged the bot first — a Telegram platform rule, not something this
  code can work around. Group mode avoids this entirely.
- Group mode: the mentioned person only gets a personal notification if
  they haven't muted the group and have a public @username set.
- The scheduled task still runs on a clock (e.g. every 20 min), not
  instantly on arrival — there's no way to get true on-arrival triggering
  through Cowork's scheduled tasks.
