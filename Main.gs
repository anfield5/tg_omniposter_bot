/**
 * ========================= ENTRY POINTS & SETUP =========================
 *
 * Run manually from the editor (select function → Run):
 *   1. setup()        — create sheets, verify the token, register the command menu
 *   2. (Deploy → New deployment → Web app: Execute as Me, Who has access: Anyone)
 *   3. setWebhook()   — connect the webhook and the scheduler trigger
 *   Alternative to step 3: usePolling() — no web app, commands are processed once a minute
 *   webhookInfo()     — diagnostics
 */

// ---------------------------- Webhook ----------------------------

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ok_();
    const secret = prop_('WEBHOOK_SECRET');
    // Apps Script can't read request headers, so the secret is passed as a URL query parameter
    if (secret && (e.parameter || {}).secret !== secret) return ok_();

    const update = JSON.parse(e.postData.contents);
    // Deduplication: Telegram re-sends an update if the response failed or was slow
    const cache = CacheService.getScriptCache();
    const key = 'upd_' + update.update_id;
    if (cache.get(key)) return ok_();
    cache.put(key, '1', 21600);

    handleUpdate_(update);
  } catch (err) {
    console.error('doPost: ' + (err && err.stack));
  }
  return ok_(); // always 200, otherwise Telegram keeps re-sending the update
}

function doGet() { return ok_(); }

/** HtmlService answers 200 directly (ContentService returns a 302 redirect, which Telegram treats as an error). */
function ok_() { return HtmlService.createHtmlOutput('ok'); }

// ---------------------------- Polling ----------------------------

function pollUpdates_() {
  const offset = Number(prop_('POLL_OFFSET') || 0);
  const r = tg_('getUpdates', { offset: offset || undefined, timeout: 0, limit: 50, allowed_updates: CFG.ALLOWED_UPDATES });
  if (!r.ok) { console.warn('getUpdates: ' + r.description); return; }
  r.result.forEach(function (u) {
    setProp_('POLL_OFFSET', u.update_id + 1); // acknowledge first, then process (no re-delivery)
    try { handleUpdate_(u); } catch (e) { console.error(e.stack); }
  });
}

// ----------------------------- Setup -----------------------------

const BOT_COMMANDS = [
  { command: 'post', description: 'Schedule a post' },
  { command: 'jobs', description: 'Active jobs' },
  { command: 'lists', description: 'All lists' },
  { command: 'showlist', description: 'Chats in a list' },
  { command: 'addlist', description: 'Create a list' },
  { command: 'removelist', description: 'Delete a list' },
  { command: 'addchat', description: 'Add a chat to a list' },
  { command: 'removechat', description: 'Remove a chat from a list / all lists' },
  { command: 'checkchats', description: 'Check bot permissions' },
  { command: 'pausejob', description: 'Pause a job' },
  { command: 'resumejob', description: 'Resume a job' },
  { command: 'stopjob', description: 'Stop a job' },
  { command: 'version', description: 'Bot version' },
  { command: 'help', description: 'Help' },
];

function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(tz_()); // dates in sheets use the script time zone
  Object.keys(SHEET_DEFS).forEach(sheet_);
  // remove the empty default sheet (its name depends on the Google account locale: EN/RU/UK)
  ['Sheet1', 'Лист1', 'Аркуш1'].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  const me = tgCall_('getMe');
  if (!getAdminIds_().length) throw new Error('Set ADMIN_IDS (send /start to the bot to find out your Telegram ID)');
  tgCall_('setMyCommands', { commands: BOT_COMMANDS, scope: { type: 'all_private_chats' } });
  console.log('OK: bot @' + me.username + ' v' + VERSION + ', time zone ' + tz_() + ', admins: ' + getAdminIds_().join(', '));
}

function setWebhook() {
  const url = prop_('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url || !/\/exec$/.test(url)) {
    throw new Error('Web app URL not found. Deploy → Web app, then set WEBAPP_URL (…/exec) in Script Properties');
  }
  let secret = prop_('WEBHOOK_SECRET');
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, ''); setProp_('WEBHOOK_SECRET', secret); }
  tgCall_('setWebhook', {
    url: url + '?secret=' + secret,
    allowed_updates: CFG.ALLOWED_UPDATES,
    max_connections: 1,          // process updates one at a time — simpler with GAS locks
    drop_pending_updates: true,
  });
  setProp_('MODE', 'webhook');
  installTriggers();
  console.log('Webhook set: ' + url);
}

function usePolling() {
  tgCall_('deleteWebhook', { drop_pending_updates: false });
  setProp_('MODE', 'polling');
  installTriggers();
  console.log('Polling mode: commands are processed every ' + CFG.TICK_MINUTES + ' min');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(CFG.TICK_MINUTES).create();
  invalidateSchedule_();
}

function webhookInfo() {
  const info = tgCall_('getWebhookInfo');
  if (info.url) info.url = info.url.replace(/secret=\w+/, 'secret=***');
  console.log(JSON.stringify(info, null, 2) + '\nMODE=' + prop_('MODE') + ', NEXT_DUE=' + prop_('NEXT_DUE'));
}
