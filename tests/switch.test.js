'use strict';
/** Server backend + switching between Apps Script and the server (shared fake Telegram & sheet). */
const assert = require('assert');
const { createWorld, defaultChats, runner } = require('./lib/world');
const { t, run } = runner();
const HOUR = 3600e3, MIN = 60e3;

/** World with Apps Script installed in webhook mode, a list "l" with 2 chats and an hourly job #1. */
async function setupWorld() {
  const w = createWorld(defaultChats());
  w.setNow(Date.UTC(2026, 9, 20, 9, 0));
  w.gas.setup();
  w.gas.setWebhook();
  w.tg.userSends('/addlist l');
  w.tg.userSends('/addchat -1001 -1002 l');
  w.tg.userSends('/post hourly -list l -start now -regularity 1h');
  w.advance(5e3);
  w.gas.tick(); // slot 1 by Apps Script
  const srv = w.createServer();
  await srv.init();
  return { w, srv, b: srv.backend };
}

const posts = (w, text) => w.tg.sent.filter((s) => s.text === text && String(s.chat_id) !== '42');
const lastAdmin = (w) => w.tg.adminMessages().slice(-1)[0] || '';
const jobsSheet = (w) => w.data('Jobs');

t('passive server writes heartbeats but does nothing else', async () => {
  const { w, srv, b } = await setupWorld();
  await b.controlTick();
  const ctl = w.data('Control');
  assert.equal(ctl.find((r) => r[0] === 'active_backend')[1], 'gas');
  assert.equal(ctl.find((r) => r[0] === 'server_heartbeat')[1], Date.now());
  assert.equal(b.active, false);
  w.advance(HOUR); await b.schedOnce();
  assert.equal(posts(w, 'hourly').length, 2, 'only the Apps Script slot so far');
  assert.deepEqual(srv.errors, []);
});

t('/switch server is refused while the server is offline', async () => {
  const { w } = await setupWorld();
  w.tg.userSends('/switch server');
  assert.match(lastAdmin(w), /server is offline[\s\S]*never connected/);
  assert.equal(w.tg.webhook !== null, true, 'Apps Script keeps the webhook');
});

t('Apps Script → server → Apps Script: data follows, no duplicate posts', async () => {
  const { w, srv, b } = await setupWorld();
  await b.controlTick();
  w.tg.userSends('/switch server');
  assert.match(w.tg.adminMessages().join('\n'), /Apps Script released the bot/);
  assert.equal(w.tg.webhook, null);

  await b.controlTick(); // server notices the flag and takes over
  assert.equal(b.active, true);
  assert.match(lastAdmin(w), /Server<\/b> is now handling[\s\S]*1 lists, 2 chats, 1 jobs/);

  // Apps Script is passive now: its tick must not post (the server keeps heartbeating)
  w.advance(HOUR); await b.controlTick(); w.gas.tick();
  assert.equal(posts(w, 'hourly').length, 2);

  // the server posts slot 2 and mirrors the schedule to the sheet
  await b.schedOnce();
  assert.equal(posts(w, 'hourly').length, 4);
  const log = w.data('Log');
  assert.equal(log.filter((r) => r[10] === 'server').length, 2);
  assert.equal(jobsSheet(w)[0][15], 2, 'runs mirrored');
  assert.ok(jobsSheet(w)[0][14] instanceof Date, 'next_run is a real date cell');
  assert.equal(jobsSheet(w)[0][14].getTime(), Date.UTC(2026, 9, 20, 11, 0) + 0, 'next slot = 14:00 Kyiv');

  // commands via polling; new job gets ID 2; dates parsed in the sheet time zone
  w.tg.userSends('/post once -list l -start 24.10.2026 14:00');
  await b.pollOnce();
  assert.match(lastAdmin(w), /Job #2<\/b> created[\s\S]*24\.10\.2026 14:00/);
  assert.equal(jobsSheet(w)[1][0], 2);
  assert.equal(jobsSheet(w)[1][10].getTime(), Date.UTC(2026, 9, 24, 11, 0));

  // /status from the server
  w.tg.userSends('/status');
  await b.pollOnce();
  assert.match(lastAdmin(w), /Active backend: <b>Server<\/b>[\s\S]*online/);

  // back to Apps Script; a command sent in the same batch must reach Apps Script, not get lost
  w.tg.userSends('/switch gas');
  w.tg.userSends('/lists');
  await b.pollOnce();
  assert.equal(b.active, false);
  assert.match(w.tg.adminMessages().join('\n'), /Server released the bot/);
  assert.ok(w.tg.webhook && w.tg.webhook.includes('secret='), 'webhook points to Apps Script again');
  w.tg.pump();
  assert.match(lastAdmin(w), /<b>Lists:<\/b>[\s\S]*l<\/b> — chats: 2, active jobs: 2/);

  w.advance(MIN); w.gas.tick();
  assert.match(w.tg.adminMessages().join('\n'), /Apps Script<\/b> is now handling/);
  w.advance(HOUR); w.gas.tick(); // slot 3 by Apps Script
  assert.equal(posts(w, 'hourly').length, 6, 'each slot exactly once across backends');
  await b.schedOnce();
  assert.equal(posts(w, 'hourly').length, 6, 'passive server does not post');
  assert.deepEqual(srv.errors, []);
  assert.deepEqual(w.gas.ctx.__errors, []);
});

t('auto-failover: a silent server is replaced by Apps Script, no slot is sent twice', async () => {
  const { w, b } = await setupWorld();
  await b.controlTick();
  w.tg.userSends('/switch server');
  await b.controlTick();
  w.advance(HOUR); await b.controlTick(); await b.schedOnce(); // slot 2 by the server
  assert.equal(posts(w, 'hourly').length, 4);

  // the server dies (no more heartbeats); Apps Script waits FAILOVER_MS
  w.advance(4 * MIN); w.gas.tick();
  assert.equal(w.data('Control').find((r) => r[0] === 'active_backend')[1], 'server');
  w.advance(2 * MIN); w.gas.tick();
  assert.equal(w.data('Control').find((r) => r[0] === 'active_backend')[1], 'gas');
  assert.match(w.tg.adminMessages().join('\n'), /took over automatically/);
  assert.ok(w.tg.webhook, 'webhook restored');

  w.advance(HOUR); w.gas.tick(); // slot 3 by Apps Script
  assert.equal(posts(w, 'hourly').length, 6);

  // the server comes back: it sees the flag and steps down instead of posting
  await b.controlTick();
  assert.equal(b.active, false);
  await b.schedOnce();
  assert.equal(posts(w, 'hourly').length, 6);
});

t('lease: an active server that loses the sheet stops itself before Apps Script takes over', async () => {
  const { w, srv, b } = await setupWorld();
  await b.controlTick();
  w.tg.userSends('/switch server');
  await b.controlTick();
  srv.stats.down = true;
  w.advance(2 * MIN); await b.controlTick();
  assert.equal(b.active, true, 'still within the lease');
  w.advance(2 * MIN); await b.controlTick();
  assert.equal(b.active, false, 'lease expired → stopped');
  assert.match(lastAdmin(w), /stopped handling the bot: no connection to Google Sheets/);
  w.advance(HOUR); await b.schedOnce();
  assert.equal(posts(w, 'hourly').length, 2, 'no posts from a server without a lease');
  w.gas.tick();
  assert.equal(w.data('Control').find((r) => r[0] === 'active_backend')[1], 'gas');
  assert.equal(posts(w, 'hourly').length, 4, 'Apps Script continues');
});

t('server mirror: deletions clear leftover rows; strings stay literal', async () => {
  const { w, b } = await setupWorld();
  w.tg.userSends('/addchat -1004 l');
  await b.controlTick();
  w.tg.userSends('/switch server');
  await b.controlTick();
  w.tg.userSends('/removechat -1002 l');
  w.tg.userSends('/post =SUM(A1) -list l -start now');
  await b.pollOnce();
  assert.deepEqual(w.data('Chats').map((r) => r[1]), ['-1001', '-1004']);
  assert.equal(JSON.parse(jobsSheet(w)[1][7]).text, '=SUM(A1)');
  assert.equal(jobsSheet(w)[1][6], '=SUM(A1)', 'RAW write keeps formulas as text');
});

t('time zone: dates after the DST change are stored correctly by the server', async () => {
  const { w, b } = await setupWorld();
  await b.controlTick();
  w.tg.userSends('/switch server');
  await b.controlTick();
  w.tg.userSends('/post winter -list l -start 10.11.2026 14:00'); // Kyiv is UTC+2 after 25.10
  await b.pollOnce();
  assert.equal(jobsSheet(w)[1][10].getTime(), Date.UTC(2026, 10, 10, 12, 0));
  assert.match(lastAdmin(w), /10\.11\.2026 14:00/);
});

t('/switch gas is aborted (server stays active) if the sheet is unreachable', async () => {
  const { w, srv, b } = await setupWorld();
  await b.controlTick();
  w.tg.userSends('/switch server');
  await b.controlTick();
  srv.stats.down = true;
  w.tg.userSends('/switch gas');
  await b.pollOnce();
  assert.equal(b.active, true);
  assert.equal(w.tg.webhook, null);
  assert.match(lastAdmin(w), /Internal error: Sheets API unavailable/);
  srv.stats.down = false;
  w.tg.userSends('/switch gas');
  await b.pollOnce();
  assert.equal(b.active, false);
  assert.ok(w.tg.webhook);
});

run();
