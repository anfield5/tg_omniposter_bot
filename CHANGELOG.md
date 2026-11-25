# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [2.0.0] — 2026-11-24

Two interchangeable backends (Apps Script and a Node.js server) with switching via bot commands.

### Added
- **Server backend** (`server/`): Node.js 22 + SQLite, runs in Docker on any VPS. It receives commands by long polling, schedules with ~5 s accuracy, and is free of Apps Script quotas.
- **Hybrid storage**: the server works on SQLite and mirrors every change to the same Google Sheet (tables + log), so the sheet stays a live view and the hand-over point.
- **`/switch server` / `/switch gas`**: moves the bot between backends with lists, chats, jobs and schedules. Messages sent right after the switch reach the new backend.
- **`/status`**: active backend, server heartbeat and version, last switch, job and list counts.
- **`Control` sheet** (`active_backend`, `epoch`, heartbeat, switch info, Apps Script webhook URL).
- **Auto-failover**: Apps Script takes over if the active server is silent for 5 min (`AUTO_FAILOVER=off` to disable).
- **Lease**: a server that can't reach Google Sheets for 3 min stops itself, so the backends are never active at the same time.
- `backend` column at the end of the `Log` sheet (which backend sent the post).
- **Deployment tooling**: `npm run push:gas` (bundles `core/` + `apps-script/` for clasp), `docker-compose.yml`, GitHub Actions for tests on every push and deploys of both backends on a `v*` tag.
- Test suite for the server and for switching, failover, lease and time-zone (DST) scenarios on a shared fake Telegram + Google Sheet (35 tests in total).

### Changed
- **Code layout**: shared logic moved to `core/`; the Apps Script adapter lives in `apps-script/`. Telegram I/O in core goes through effects (generators), so the same code runs synchronously in Apps Script and asynchronously on the server.
- Job IDs are now `max(job_id) + 1` from the shared table (no more per-backend counter).
- Times are epoch milliseconds inside the core; sheets keep real date cells.

### Upgrading from 1.0.0
1. `npm install`, create `.clasp.json` from `.clasp.json.example`, then `npm run push:gas` (replaces the old files in the Apps Script project).
2. Run `setup()` once (creates the `Control` sheet and date formats), then `setWebhook()`.
3. Existing lists, chats and jobs are kept. `setup()` adds the new `backend` column at the end of the `Log` header; older rows simply leave it empty.

## [1.0.0] — 2026-10-26

First public release. A serverless Telegram bot (Google Apps Script + Google Sheets) that posts scheduled content to lists of channels and groups.

### Lists & chats
- `/addlist`, `/removelist`, `/lists`, `/showlist` manage named lists. Deleting a list also removes its chats and stops its jobs.
- `/addchat id [id2 …] list` adds one or more chats by numeric ID, `@username` or `t.me` link. Before adding, it verifies that the bot is in the chat and can post: admin with "Post messages" in channels; allowed to write in groups. It also warns about slow mode and media restrictions.
- `/removechat id [list]` removes a chat from one list, or from all lists if no list is given.
- `/checkchats [list]` re-checks permissions for all chats in parallel.
- When the bot is added, removed or has its rights changed, it DMs the admin the chat ID, its status and a ready-made `/addchat` command.

### Posting
- `/post <text> -list name | -chat id` with:
  - `-start "dd.MM.yyyy HH:mm" | now` — first post (defaults to now);
  - `-regularity 2h` — repeat interval (`m`/`h`/`d`, decimals allowed, min 5 min);
  - `-end "dd.MM.yyyy HH:mm"` — last post, inclusive;
  - `-mix X in N` — first post to all chats, then every X to N random chats.
- One-time, recurring and open-ended schedules.
- Formatting (bold, links, spoilers, etc.) is preserved via message entities.
- Media posts: send media with a `/post …` caption, or reply `/post …` to any message to copy it as is.
- List membership is resolved at each post, so newly added chats are included.

### Jobs
- `/jobs` lists active and paused jobs with next run, delivery count and last error.
- `/pausejob`, `/resumejob` and `/stopjob` control jobs. Resuming skips missed slots instead of burst-sending.

### Reliability
- At-most-once delivery: the schedule is advanced before sending, so a crash never duplicates posts.
- Parallel batched sending with `429 retry_after` handling.
- Group → supergroup migration: the bot updates the chat ID automatically and resends.
- Admins are notified of delivery failures only when the error set changes (no spam), and get a summary when a job finishes.
- A webhook secret, `update_id` deduplication, and admin-only access via `ADMIN_IDS`. A polling fallback (`usePolling()`) is available.

### Storage & logging
- Google Sheets tabs `Lists`, `Chats`, `Jobs` and `Log`. Every delivery is logged with `message_id`, a post link and its status.
- Strings are always stored as text, so the sheet never turns data into formulas, numbers or dates. Blank or manual rows are tolerated.
- Per-execution read cache and grouped row deletion keep sheet calls to a minimum.

### Misc
- `/version` shows the bot version, mode and time zone. `/help` lists all commands.
- Node test suite with Apps Script and Telegram mocks (26 tests).
