# Telegram Autopost Bot

**Version 2.0.0** · [Changelog](CHANGELOG.md)

A Telegram bot that publishes scheduled posts to lists of channels and groups. It has **two interchangeable backends** that share one codebase, one bot token, and one Google Sheet:

| Backend | Runs on | Storage | Receives commands via |
|---|---|---|---|
| **Apps Script** (`gas`) | Google's servers, free, no server needed | Google Sheet | webhook |
| **Server** (`server`) | your VPS (Docker) | SQLite, mirrored to the Google Sheet | long polling |

Only one backend is active at a time. You move the bot between them with **`/switch server`** and **`/switch gas`**, and lists, chats, jobs and schedules follow along. If the active server goes silent, Apps Script **takes over automatically**.

## Architecture

```
                          ┌──────────── Google Sheet ────────────┐
                          │ Lists · Chats · Jobs · Log · Control │
                          └──────▲───────────────────────▲───────┘
                     read/write  │                       │  mirror (after every change)
                                 │                       │  + import on takeover
 Telegram ──webhook──▶ Apps Script backend        Server backend ◀──getUpdates── Telegram
                       (doPost, tick/1 min)        (Node.js, SQLite, Docker)
                                 └──────── core/ (shared code) ───────┘
```

- **`core/`** contains all bot logic: command parsing, scheduling, mix mode, permission checks and message texts. Both backends run exactly the same files.
- Core functions that talk to Telegram are generators that `yield` *effects* (`tg`, `batch`, `sleep`, `checkpoint`, …). Apps Script executes them synchronously with `UrlFetchApp`; the server executes them asynchronously with `fetch`. Storage, lock, time zone and secrets come from a small `PLATFORM` adapter.
- **`Control` sheet** holds `active_backend`, `epoch`, `server_heartbeat`, `switched_at/by`, and the Apps Script webhook URL.

### Switching and safety

| Situation | What happens |
|---|---|
| `/switch server` (handled by Apps Script) | Refused unless the server heartbeat is < 90 s old. Otherwise: flag → `server`, webhook removed. Within ≤ 15 s the server imports the sheet into SQLite, starts polling, and confirms in chat. |
| `/switch gas` (handled by the server) | The server flushes SQLite to the sheet, confirms the processed update, sets the flag to `gas` and points the webhook back to Apps Script. Messages sent after the switch command are delivered to Apps Script. Apps Script confirms within ≤ 1 min. |
| Server crashes or loses its network | Apps Script takes over after **5 min** without a heartbeat and notifies you (disable with the script property `AUTO_FAILOVER=off`). |
| Server can't reach Google Sheets | It stops itself after **3 min** (lease), *before* Apps Script takes over, so the two never post at the same time. |
| Server restarts while Apps Script is active | It stays passive. |
| Duplicates | A post's next slot is saved (and mirrored to the sheet) **before** it is sent, so a slot is never sent twice, even across a failover. |

While the server is active the sheet is a live mirror: view it freely, but edit data through the bot, because the server overwrites manual edits.

## Repository layout

```
core/                shared bot logic (plain JS, loaded as globals on both backends)
apps-script/         Apps Script adapter: Platform.gs (Sheets, Control, sync driver), Main.gs, appsscript.json
server/              Node.js backend: src/ (backend, SQLite, Sheets mirror, Telegram), Dockerfile, .env.example
scripts/build-gas.js bundles core + apps-script into dist/apps-script for clasp
tests/               Node test suite: Apps Script backend, server, switching & failover
docker-compose.yml   runs the server
.github/workflows/   tests on every push; deploys both backends on a version tag
```

## Commands

```
/addlist news                         — create a list
/removelist news                      — delete a list and its chats; its jobs are stopped
/lists, /showlist news                — view lists
/addchat -1001234567890 news          — add chats (several IDs, @username or t.me links)
/removechat -1001234567890 news       — remove from one list
/removechat -1001234567890            — remove from all lists
/checkchats [news]                    — re-check the bot's permissions

/post hello hello -list news -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00
/post hi, andrew -list news -start 24.10.2026 14:00 -mix 0.75h in 2
/post hi, andrew -chat -1001234567890 -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00

/jobs, /pausejob 3, /resumejob 3, /stopjob 3

/status                               — active backend, server health, counts
/switch server | /switch gas          — move the bot between backends
/version, /help
```

`/post` rules:
- The text is everything before the first flag. It may span multiple lines and include formatting.
- No `-start` (or `-start now`) means the post goes out now.
- No `-regularity` or `-mix` means a one-time post.
- `-end` is inclusive.
- `-mix X in N`: the first post goes to all chats, then every X to N random chats.
- Intervals: `2h`, `0.75h`, `45m`, `1d` (minimum 5 min).
- Dates: `24.10.2026 14:00` in the sheet's time zone (`Europe/Kiev` by default).
- **Media:** send media with the caption `/post … -list …`, or reply `/post -list …` to any message.
- Flags also accept "—" (iOS turns `--` into an em dash).

**Bot permissions:**
- **Channel:** the bot must be an admin with the "Post messages" right.
- **Group:** a regular member is enough if members can send messages.
- `/addchat` checks this upfront.
- When you add the bot to a chat, it DMs you the chat ID.

## Setup

### 1. Apps Script backend (required: it owns the sheet and is the fallback)

1. Create the bot in @BotFather and copy the token.
2. Create a Google Sheet → **Extensions → Apps Script**. Copy the **Script ID** (Project Settings).
3. On your computer (Node 22+):
   ```bash
   npm install                      # installs clasp and the server dependencies
   npx clasp login                  # once; enable the API at https://script.google.com/home/usersettings
   cp .clasp.json.example .clasp.json   # put your Script ID inside
   npm run push:gas                 # builds dist/apps-script and uploads it
   ```
4. **Project Settings → Script properties:** `BOT_TOKEN`, `ADMIN_IDS` (your Telegram ID; the bot tells it to you on `/start`).
5. Run `setup()` in the editor and grant the permissions. It creates the `Lists`, `Chats`, `Jobs`, `Log` and `Control` sheets.
6. **Deploy → New deployment → Web app:** *Execute as:* Me; *Who has access:* **Anyone**. Save the `…/exec` URL as the `WEBAPP_URL` script property. Note the **deployment ID**.
7. Run `setWebhook()`. Then send `/help` to the bot.

### 2. Server backend (optional)

1. **Service account** (one time, ~5 min): in [Google Cloud Console](https://console.cloud.google.com/):
   - create a project and enable the **Google Sheets API**;
   - go to IAM → Service accounts → Create, then Keys → Add key → JSON;
   - download the key file;
   - open the bot's Google Sheet → **Share** → add the service account e-mail as **Editor**.
2. **VPS** with Docker (any provider; 1 vCPU / 1 GB RAM is plenty):
   ```bash
   git clone https://github.com/<you>/tg_post_bot.git && cd tg_post_bot
   cp server/.env.example server/.env        # BOT_TOKEN, ADMIN_IDS, SPREADSHEET_ID
   nano server/.env
   # upload the key as server/credentials.json, then make it readable for the container user:
   chmod 644 server/credentials.json
   docker compose up -d --build
   docker compose logs -f                    # "tg-post-bot server v2.0.0, time zone Europe/Kiev"
   ```
   The server starts **passive**: it only writes heartbeats. `/status` should now show *Server: 🟢 online*.
3. Send **`/switch server`**. The server confirms in chat when it has taken over.

## Updating

**Manually:**
```bash
# Apps Script (the web app URL stays the same)
npm run push:gas && npx clasp deploy -i <DEPLOYMENT_ID> -d "v2.0.1"

# Server (SQLite data lives in a Docker volume and survives rebuilds)
ssh you@vps 'cd tg_post_bot && git pull && docker compose up -d --build'
```

**Automatically:** push a tag and GitHub Actions tests and deploys both backends (see `.github/workflows/deploy.yml` for the required secrets):
```bash
git tag v2.0.1 && git push --tags
```

A server restart takes a few seconds. Telegram keeps pending messages, and failover only starts after 5 minutes, so updates don't cause a switch.

## Limits

| | Apps Script | Server |
|---|---|---|
| Schedule accuracy | ±1 min (posts may go up to 30 s early) | ~5 s |
| Command response | 1–3 s | < 1 s (+ sheet mirroring in the background) |
| Quotas | 90 min of triggers/day, 20k fetches/day | Sheets API ~300 requests/min |

Intervals are absolute time, so after a DST switch "every 1d" shifts by an hour in local time. For albums, only the replied-to message is copied.

## Tests

```bash
npm install
npm test     # Apps Script backend + server + switching/failover scenarios
```

The suite runs the real code against a fake Telegram and a fake Google Sheet, which both backends share in-process.
