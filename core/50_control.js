/**
 * ========================== BACKEND CONTROL ==========================
 * Two backends share one bot token and one Google Sheet. The Control sheet says which one is active:
 *
 *   active_backend   gas | server — only this one receives commands and publishes posts
 *   epoch            incremented on every switch
 *   server_heartbeat the server writes "I'm alive" every CFG.HEARTBEAT_MS (even when passive)
 *
 * /switch server  (handled by Apps Script): checks the heartbeat, flips the flag, removes the webhook;
 *                 the server notices within seconds, imports the sheet into SQLite and starts polling.
 * /switch gas     (handled by the server): flushes SQLite to the sheet, flips the flag, points the webhook
 *                 back to Apps Script.
 * Failover: if the active server is silent for CFG.FAILOVER_MS, Apps Script takes over automatically.
 * Lease:    an active server that can't reach the sheet for CFG.LEASE_MS (< FAILOVER_MS) stops itself,
 *           so the two backends are never active at the same time.
 */

function normalizeBackend_(s) {
  const v = lc_(s || '');
  if (v === 'gas' || v === 'appsscript' || v === 'apps-script' || v === 'google') return 'gas';
  if (v === 'server' || v === 'vps' || v === 'node') return 'server';
  return null;
}

function activeBackend_(ctl) { return normalizeBackend_(ctl && ctl.active_backend) || 'gas'; }

function serverAlive_(ctl) {
  return !!(ctl && ctl.server_heartbeat && Date.now() - Number(ctl.server_heartbeat) < CFG.SERVER_ALIVE_MS);
}

function* cmdSwitchE_(msg, args) {
  const to = normalizeBackend_(args);
  if (!to) throw new UserError('Usage: <code>/switch server</code> or <code>/switch gas</code>');
  const ctl = yield* getControlE_();
  const active = activeBackend_(ctl);
  if (to === active) { yield* replyE_(msg.chat.id, 'ℹ️ ' + BACKEND_NAMES[to] + ' is already active. See /status'); return; }

  if (to === 'server' && !serverAlive_(ctl)) {
    throw new UserError('The server is offline' +
      (ctl.server_heartbeat ? ' (last heartbeat ' + fmtAgo_(Number(ctl.server_heartbeat)) + ')' : ' (it has never connected)') +
      '. Start it first, then retry.');
  }
  if (to === 'gas' && !ctl.gas_webhook_url) {
    throw new UserError('The Apps Script webhook URL is unknown. Run <code>setWebhook()</code> in Apps Script once, then retry.');
  }

  yield* replyE_(msg.chat.id, '🔄 Switching to <b>' + BACKEND_NAMES[to] + '</b>…');
  const res = yield* handoverE_(to, 'user ' + msg.from.id);
  yield* replyE_(msg.chat.id, res + '\n' + BACKEND_NAMES[to] + ' will confirm when it takes over.');
}

function* cmdStatusE_(msg) {
  const ctl = yield* getControlE_();
  const active = activeBackend_(ctl);
  const jobs = readJobs_();
  const count = function (st) { return jobs.filter(function (j) { return j.status === st; }).length; };
  const hb = Number(ctl.server_heartbeat || 0);
  const server = !hb ? 'never connected'
    : serverAlive_(ctl) ? '🟢 online (heartbeat ' + fmtAgo_(hb) + (ctl.server_version ? ', v' + esc_(ctl.server_version) : '') + ')'
    : '🔴 offline (last heartbeat ' + fmtAgo_(hb) + ')';

  yield* replyE_(msg.chat.id, [
    '<b>Status</b>',
    'Active backend: <b>' + BACKEND_NAMES[active] + '</b>' + (active === PLATFORM.name ? '' : ' ⚠️ (but this reply came from ' + BACKEND_NAMES[PLATFORM.name] + ')'),
    'Server: ' + server,
    ctl.switched_at ? 'Last switch: ' + fmtDate_(Number(ctl.switched_at)) + ' by ' + esc_(ctl.switched_by || '—') : '',
    'Jobs: ' + count('active') + ' active, ' + count('paused') + ' paused',
    'Lists: ' + rows_('lists').length + ' · chats: ' + rows_('chats').length,
    'Version: ' + VERSION + ' · time zone: ' + esc_(tz_()),
  ].filter(Boolean).join('\n'));
}
