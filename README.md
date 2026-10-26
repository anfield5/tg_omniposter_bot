# Telegram Autopost Bot

**Version 1.0.0** · [Changelog](CHANGELOG.md)

A Telegram bot that publishes scheduled posts to lists of channels and groups. **No server required**: it runs on free Google Apps Script, and all data (lists, chats, post templates, and a delivery log with `message_id`s) lives in a Google Sheet.

## Architecture

```
Telegram ──webhook──▶ doPost()  (Apps Script Web App)
                        └─ handleUpdate_ → commands → Google Sheets (Lists / Chats / Jobs)
Time trigger (1 min) ─▶ tick()
                        ├─ NEXT_DUE not reached? → exit in milliseconds, sheet untouched
                        └─ due jobs → sendMessage/copyMessage (parallel, fetchAll)
                                    → Log sheet (message_id, link, errors)
```

| Sheet   | Contents |
|---------|----------|
| `Lists` | lists |
| `Chats` | list ↔ chat links (ID, title, type, @username); one chat can be in several lists |
| `Jobs`  | post templates and schedules: text + formatting, target, start, interval, end, mix, next run, status |
| `Log`   | every delivery: time, job, chat, **message_id**, post link, status/error |

Files: `Config.gs` (settings), `Telegram.gs` (Bot API, permission checks), `Storage.gs` (Sheets), `Parser.gs` (command & schedule parsing), `Scheduler.gs` (delivery), `Commands.gs` (commands), `Main.gs` (webhook & setup).

### Tech stack

| Component | Role | Why |
|-----------|------|-----|
| Google Apps Script (V8 JavaScript) | runtime | free Google-hosted cloud runtime: no server, VPS, or bills |
| Web App + webhook | receives commands | Telegram pushes updates to the script, so replies are instant |
| Time-driven trigger | scheduler | built-in, no external cron |
| Google Sheets | storage & log | human-readable and editable, free, zero setup |
| Raw Telegram Bot API | messaging | bot frameworks don't run in Apps Script; raw calls give full control over limits, retries, and parallel sends |
| Script Properties | secrets | the token never lives in code or in the sheet |

### Design decisions
- **At-most-once delivery:** the schedule is advanced before sending, so if Google kills the execution mid-run, posts are not duplicated across chats.
- **Missed slots are skipped, not burst-sent:** after a delayed trigger or a pause, the bot posts at the next future slot.
- **Quota-friendly:** the next due time is cached in Script Properties, so the per-minute `tick()` costs almost nothing.
- **Telegram rate limits:** sends in batches of 20 with ~1 s pauses. On `429`, the bot waits for `retry_after` and retries.
- **Group upgraded to supergroup** (`migrate_to_chat_id`): the bot updates the ID in all lists and resends.
- **Webhook security:** secret in the URL, `update_id` deduplication, commands accepted only in private chat from `ADMIN_IDS`.
- **Formatting preserved** (bold, links, spoilers, etc.) by carrying over message `entities`. Photos, videos and documents are posted via `copyMessage`.
- **Sheet-safe writes:** every string is stored as text, so `=SUM(...)`, `-100123…`, `24.10.2026`, `TRUE` and `1.50` never turn into formulas, numbers or dates.
- **Fewer sheet reads:** each sheet is read once per command or scheduler run. Adjacent rows are deleted in a single call.
- **Batched permission checks:** `/addchat` and `/checkchats` check all chats in parallel, so 50 chats take ~2–3 s instead of ~40 s and the webhook never times out.
- **Manual sheet edits are safe:** blank rows are skipped, and there's no cache between runs.

## Does the bot need to be in the chat? Which rights?

Yes. The Bot API **does not allow** posting to chats the bot isn't in. `/addchat` and `/post -chat` therefore check this upfront (`getChat` + `getChatMember`) and explain any problem.

| Chat type | Minimum |
|-----------|---------|
| **Channel** | bot is an **administrator** with just the **"Post messages"** right. Everything else can be off. |
| **Group / supergroup** | a **regular member** is enough if members may send messages. Otherwise the bot needs admin status, even with no rights ticked. |

Warnings (they don't block adding):
- **Slow mode** applies to a non-admin bot, so make it an admin for frequent posting.
- If members can't send media, photo posts will fail.
- Telegram limits sending to about 20 messages per minute per group and about 30 per second overall.

Rights can change later (the bot is removed or demoted). The bot then tells you once which chats failed and why. Run `/checkchats` for a full check.

**Finding a chat ID:** add the bot to the channel or group, and it will DM you the ID, its status and a ready-made `/addchat` command. You can also use `@username` or a `t.me/...` link.

## Commands

```
/addlist news                         — create a list
/removelist news                      — delete a list and its chats; its jobs are stopped
/lists, /showlist news                — view lists
/addchat -1001234567890 news          — add a chat (several IDs separated by spaces allowed)
/removechat -1001234567890 news       — remove from one list
/removechat -1001234567890            — remove from all lists
/checkchats [news]                    — re-check the bot's permissions

/post hello hello -list news -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00
/post hi, andrew -list news -start 24.10.2026 14:00 -mix 0.75h in 2
/post hi, andrew -chat -1001234567890 -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00

/jobs, /pausejob 3, /resumejob 3, /stopjob 3
/version                              — bot version
/help                                 — help
```

`/post` rules:
- The text is everything before the first flag. It may span multiple lines and include formatting.
- No `-start` (or `-start now`) means the post goes out now, within a minute.
- No `-regularity` or `-mix` means a one-time post.
- `-end` is inclusive: the last post is no later than that time.
- `-mix X in N`: the first post goes to all chats, then every X to N random chats (all chats if there are ≤ N). Without `-end` it runs indefinitely.
- Intervals: `2h`, `0.75h`, `45m`, `1d`. The minimum is 5 min (`CFG.MIN_INTERVAL_MIN`).
- Dates use the format `24.10.2026 14:00` in the script time zone (`Europe/Kiev`, set in `appsscript.json`).
- **Media:** send a photo or video with the caption `/post caption text -list news -start ...`, or reply `/post -list news ...` to any message. The bot copies it as is, so don't delete the original message.
- List membership is resolved at each post, so chats added later receive posts too.
- Flags also accept "—", because iOS auto-replaces `--` with an em dash.

## Setup (~10 minutes)

1. **Bot.** In @BotFather run `/newbot` and copy the token.
2. **Sheet.** Create a new Google Sheet, then open **Extensions → Apps Script**.
3. **Code.** Create the script files `Config`, `Telegram`, `Storage`, `Parser`, `Scheduler`, `Commands` and `Main`, and paste in the matching `.gs` files. In **Project Settings** enable *Show "appsscript.json"* and replace its contents with the file from this repo.
   *Or use [clasp](https://github.com/google/clasp): `clasp create --type sheets`, then `clasp push`.*
4. **Secrets.** In **Project Settings → Script properties** add:
   - `BOT_TOKEN` — the bot token;
   - `ADMIN_IDS` — your Telegram ID. Get it from @userinfobot, or send `/start` to the bot after setup and it will reply with your ID.
5. **setup.** Select the `setup` function, click **Run**, and grant the Google permissions.
6. **Deploy.** Click **Deploy → New deployment → Web app**:
   - *Execute as:* **Me**;
   - *Who has access:* **Anyone** (not "Anyone with Google account", or Telegram can't reach it).

   Copy the `…/exec` URL and save it as the `WEBAPP_URL` script property.
7. **setWebhook.** Run `setWebhook`. It connects the webhook and creates the per-minute trigger.
8. Send `/help` to the bot.

**Updating the code:** go to Deploy → Manage deployments → ✏️ → Version: *New version*. The URL stays the same, so the webhook doesn't need resetting.

**Diagnostics:** `webhookInfo()` shows `last_error_message` and the pending update count. If you see persistent errors (e.g. `302`), switch to `usePolling()`. That mode needs no web app, and commands are processed once a minute.

## Free Apps Script limits
- Schedule accuracy is ±1 minute: the trigger fires once a minute at a random second, so a post may go out up to 30 s early.
- Trigger runtime is 90 min/day (6 h on Workspace accounts), and external requests are capped at 20,000/day. An idle `tick()` takes a fraction of a second, which leaves room for hundreds of posts per day.
- Intervals are absolute time. After a DST switch, "every 1d" shifts by an hour in local time.
- For albums, only the message you replied to is copied.

## Versioning
The version is set in `Config.gs` (`VERSION`, `RELEASE_DATE`) and shown by `/version`. For a new release, bump `VERSION`, `RELEASE_DATE` and `CHANGELOG.md`, then create a git tag.

## Tests
`tests/` contains a Node harness with Apps Script and Telegram mocks. Run `node tests/test.js`. The tests cover every spec example, mix mode, permission errors, group migration, pause/resume, update deduplication, and the regressions above.
