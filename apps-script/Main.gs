/**
 * ===================== APPS SCRIPT ENTRY POINTS & SETUP =====================
 *
 * Run manually from the editor (select function → Run):
 *   1. setup()        — create sheets, verify the token, register the command menu
 *   2. (Deploy → New deployment → Web app: Execute as Me, Who has access: Anyone)
 *   3. setWebhook()   — connect the webhook and the per-minute trigger
 *   Alternative to step 3: usePolling() — no web app, commands processed once a minute
 *                          (backend switching requires webhook mode)
 *   webhookInfo()     — diagnostics
 *
 * Script Properties: BOT_TOKEN, ADMIN_IDS (required), WEBAPP_URL (if not auto-detected),
 * AUTO_FAILOVER=off to disable automatic takeover from a silent server.
 */

const TICK_MINUTES = 1;

// ---------------------------- Webhook ----------------------------

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ok_();
    const secret = PLATFORM.getProp('WEBHOOK_SECRET');
    // Apps Script can't read request headers, so the secret is passed as a URL query parameter
    if (secret && (e.parameter || {}).secret !== secret) return ok_();

    const update = JSON.parse(e.postData.contents);
    // Deduplication: Telegram re-sends an update if the response failed or was slow
    const cache = CacheService.getScriptCache();
    const key = 'upd_' + update.update_id;
    if (cache.get(key)) return ok_();
    cache.put(key, '1', 21600);

    if (activeBackend_(readControl_()) !== 'gas') return ok_(); // the server is in charge
    runE_(handleUpdateE_(update));
  } catch (err) {
    console.error('doPost: ' + (err && err.stack));
  }
  return ok_(); // always 200, otherwise Telegram keeps re-sending the update
}

function doGet() { return ok_(); }

/** HtmlService answers 200 directly (ContentService returns a 302 redirect, which Telegram treats as an error). */
function ok_() { return HtmlService.createHtmlOutput('ok'); }

// ----------------------------- Trigger -----------------------------

/** Every minute: failover check, polling (if enabled), scheduler. */
function tick() {
  const ctl = readControl_();
  if (activeBackend_(ctl) === 'server') {
    if (!shouldFailover_(ctl)) { PLATFORM.setProp('LAST_ACTIVE', 'server'); return; }
    takeOverFromServer_(ctl);
  }
  const last = PLATFORM.getProp('LAST_ACTIVE');
  if (last !== 'gas') {
    invalidateSchedule_(); // jobs were changed by the server meanwhile
    PLATFORM.setProp('LAST_ACTIVE', 'gas');
    if (last === 'server') {
      // the server handed the bot over (/switch gas): make sure Telegram points here, then confirm
      if (ctl.gas_webhook_url && PLATFORM.getProp('MODE') !== 'polling') {
        gasTg_('setWebhook', { url: ctl.gas_webhook_url, allowed_updates: CFG.ALLOWED_UPDATES, max_connections: 1 });
      }
      runE_(notifyAdminsE_('✅ <b>Apps Script</b> is now handling the bot (v' + VERSION + ').'));
    }
  }
  if (PLATFORM.getProp('MODE') === 'polling') {
    try { pollUpdates_(); } catch (e) { console.error('poll: ' + e.stack); }
  }
  runE_(runSchedulerE_());
}

function shouldFailover_(ctl) {
  if (PLATFORM.getProp('AUTO_FAILOVER') === 'off') return false;
  const lastSign = Math.max(Number(ctl.server_heartbeat || 0), Number(ctl.switched_at || 0));
  return Date.now() - lastSign > CFG.FAILOVER_MS;
}

/** The active server went silent: take the bot back. The server's lease has already expired by now. */
function takeOverFromServer_(ctl) {
  writeControl_({ active_backend: 'gas', epoch: (ctl.epoch || 0) + 1, switched_at: Date.now(), switched_by: 'auto-failover' });
  if (ctl.gas_webhook_url && PLATFORM.getProp('MODE') !== 'polling') {
    gasTg_('setWebhook', { url: ctl.gas_webhook_url, allowed_updates: CFG.ALLOWED_UPDATES, max_connections: 1 });
  }
  invalidateSchedule_();
  PLATFORM.setProp('LAST_ACTIVE', 'gas');
  runE_(notifyAdminsE_('⚠️ The server has been silent for ' + Math.round(CFG.FAILOVER_MS / 60000) +
    ' min (last heartbeat: ' + (ctl.server_heartbeat ? fmtDate_(ctl.server_heartbeat) : 'never') + ').\n' +
    '<b>Apps Script took over automatically.</b> When the server is back: /switch server'));
}

// ---------------------------- Polling ----------------------------

function pollUpdates_() {
  const offset = Number(PLATFORM.getProp('POLL_OFFSET') || 0);
  const r = gasTg_('getUpdates', { offset: offset || undefined, timeout: 0, limit: 50, allowed_updates: CFG.ALLOWED_UPDATES });
  if (!r.ok) { console.warn('getUpdates: ' + r.description); return; }
  r.result.forEach(function (u) {
    PLATFORM.setProp('POLL_OFFSET', String(u.update_id + 1)); // acknowledge first, then process (no re-delivery)
    try { runE_(handleUpdateE_(u)); } catch (e) { console.error(e.stack); }
  });
}

// ----------------------------- Setup -----------------------------

function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(tz_()); // dates in sheets use the script time zone
  Object.keys(SCHEMA).forEach(function (t) { sheet_(t); writeHeader_(t); formatTimeColumns_(t); });
  controlSheet_();
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
  const url = PLATFORM.getProp('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url || !/\/exec$/.test(url)) {
    throw new Error('Web app URL not found. Deploy → Web app, then set WEBAPP_URL (…/exec) in Script Properties');
  }
  let secret = PLATFORM.getProp('WEBHOOK_SECRET');
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, ''); PLATFORM.setProp('WEBHOOK_SECRET', secret); }
  const hookUrl = url + '?secret=' + secret;
  writeControl_({ gas_webhook_url: hookUrl }); // the server uses it for /switch gas

  if (activeBackend_(readControl_()) === 'server') {
    PLATFORM.setProp('MODE', 'webhook');
    installTriggers();
    console.log('Webhook URL saved. The server is active now, so Telegram stays connected to it. Use /switch gas to move back.');
    return;
  }
  tgCall_('setWebhook', {
    url: hookUrl,
    allowed_updates: CFG.ALLOWED_UPDATES,
    max_connections: 1,          // process updates one at a time — simpler with GAS locks
    drop_pending_updates: true,
  });
  PLATFORM.setProp('MODE', 'webhook');
  installTriggers();
  console.log('Webhook set: ' + url);
}

function usePolling() {
  tgCall_('deleteWebhook', { drop_pending_updates: false });
  PLATFORM.setProp('MODE', 'polling');
  installTriggers();
  console.log('Polling mode: commands are processed every ' + TICK_MINUTES + ' min');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(TICK_MINUTES).create();
  invalidateSchedule_();
}

function webhookInfo() {
  const info = tgCall_('getWebhookInfo');
  if (info.url) info.url = info.url.replace(/secret=\w+/, 'secret=***');
  const ctl = readControl_();
  console.log(JSON.stringify(info, null, 2) + '\nMODE=' + PLATFORM.getProp('MODE') + ', NEXT_DUE=' + PLATFORM.getProp('NEXT_DUE') +
    ', active backend=' + activeBackend_(ctl) + ', server heartbeat=' + (ctl.server_heartbeat ? fmtDate_(ctl.server_heartbeat) : 'never'));
}
