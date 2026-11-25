'use strict';
/** Apps Script backend: commands, parser, scheduler (ported v1 suite + v2 regressions). */
const assert = require('assert');
const { createWorld, defaultChats, runner } = require('./lib/world');
const { t, run } = runner();
const D = (sh) => sh.rows.slice(1).filter((r) => r.some((v) => v !== ''));
const HOUR = 3600e3, MIN = 60e3;
const chats = defaultChats;

/** v1-style harness facade over the shared test world (Apps Script only). */
function makeEnv(opts = {}) {
  const w = createWorld((opts.tg && opts.tg.chats) || chats());
  if (opts.tg) { opts.tg.chats = w.tg.chats; if (opts.tg.migrate) w.tg.migrate = opts.tg.migrate; }
  w.setNow(Date.UTC(2026, 9, 20, 9, 0));
  w.gas.setup();
  let uid = 1000, mid = 1;
  const ctx = w.gas.ctx;
  Object.defineProperty(ctx, '__deleteCalls', { get: () => w.gas.counters.deleteRows, set: (v) => { w.gas.counters.deleteRows = v; }, configurable: true });
  Object.defineProperty(ctx, '__fetch', { get: () => w.gas.counters.fetch, set: (v) => { w.gas.counters.fetch = v; }, configurable: true });
  Object.defineProperty(ctx, '__fetchAll', { get: () => w.gas.counters.fetchAll, set: (v) => { w.gas.counters.fetchAll = v; }, configurable: true });
  const sent = w.tg.sent;
  return {
    ctx, sheets: w.store.sheets, sent, world: w,
    advance: w.advance, setNow: w.setNow, now: () => Date.now(),
    cmd(text, extra = {}) {
      const before = sent.length;
      w.gas.doPost({ update_id: uid++, message: Object.assign({ message_id: mid++, chat: { id: 42, type: 'private' }, from: { id: 42 }, text }, extra) });
      return sent.slice(before).filter((s) => String(s.chat_id) === '42').map((s) => s.text).join('\n---\n');
    },
    tickAll() { const b = sent.length; w.gas.tick(); return sent.slice(b); },
    tick() { return this.tickAll().filter((s) => String(s.chat_id) !== '42'); },
  };
}
// ---------- pure parser ----------
const env0 = makeEnv({ tg: { chats: chats() } });
const _now0 = Date.UTC(2026, 9, 20, 9, 0);
const P = env0.ctx;
t('duration', () => {
  assert.equal(P.parseDuration_('2h'), 120); assert.equal(P.parseDuration_('0.75h'), 45);
  assert.equal(P.parseDuration_('45m'), 45); assert.equal(P.parseDuration_('1d'), 1440); assert.equal(P.parseDuration_('1,5h'), 90);
  assert.throws(() => P.parseDuration_('2m')); assert.throws(() => P.parseDuration_('abc'));
});
t('date', () => {
  assert.equal(P.parseDateTime_('24.10.2026 14:00', 'x').ms, Date.UTC(2026, 9, 24, 11, 0));
  assert.throws(() => P.parseDateTime_('31.02.2026 14:00', 'x')); assert.throws(() => P.parseDateTime_('24/10/2026', 'x'));
});
t('parse example 1', () => {
  const r = P.parsePostArgs_('/post hello hello -list newschannels -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00', [], _now0, 'x');
  assert.equal(r.text, 'hello hello'); assert.equal(r.target.value, 'newschannels'); assert.equal(r.interval, 120);
  assert.equal(P.countRuns_(r.startMs, r.interval, r.endMs), 396);
});
t('parse example 2 (mix)', () => {
  const r = P.parsePostArgs_('/post hi, andrew -list newschannels -start 24.10.2026 14:00 -mix 0.75h in 2', [], _now0, 'x');
  assert.equal(r.text, 'hi, andrew'); assert.equal(r.interval, 45); assert.equal(r.mixCount, 2); assert.equal(r.endMs, null);
});
t('parse example 3 (chat, quotes, em-dash)', () => {
  const r = P.parsePostArgs_('/post hi, andrew —chat -1001 -start "24.10.2026 14:00" -regularity 2h -end 26.11.2026 12:00', [], _now0, 'x');
  assert.equal(r.target.type, 'chat'); assert.equal(r.target.value, '-1001');
});
t('multiline + entities shift', () => {
  const raw = '/post  Hello *bold*\nline2 -list x';
  const ents = [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'bold', offset: 13, length: 6 }];
  const r = P.parsePostArgs_(raw, ents, _now0, 'x');
  assert.equal(r.text, 'Hello *bold*\nline2'); assert.equal(r.entities.length, 1);
  assert.equal(r.text.substr(r.entities[0].offset, r.entities[0].length), '*bold*');
});
t('validation errors', () => {
  const n = _now0;
  assert.throws(() => P.parsePostArgs_('/post hi', [], n, 'x'), /where to post/);
  assert.throws(() => P.parsePostArgs_('/post hi -list a -chat 1', [], n, 'x'));
  assert.throws(() => P.parsePostArgs_('/post hi -list a -start 01.01.2020 10:00', [], n, 'x'), /in the past/);
  assert.throws(() => P.parsePostArgs_('/post hi -list a -end 01.01.2030 10:00', [], n, 'x'), /-end/);
  assert.throws(() => P.parsePostArgs_('/post hi -chat 1 -mix 1h in 2', [], n, 'x'));
  assert.throws(() => P.parsePostArgs_('/post hi -list a -list b', [], n, 'x'), /twice/);
});
t('computeNextRun skips missed slots, end inclusive', () => {
  assert.equal(P.computeNextRun_(0, 60, null, 10 * MIN), HOUR);
  assert.equal(P.computeNextRun_(0, 60, null, 3.5 * HOUR), 4 * HOUR);
  assert.equal(P.computeNextRun_(0, 60, 2 * HOUR, 1.5 * HOUR), 2 * HOUR);
  assert.equal(P.computeNextRun_(2 * HOUR, 60, 2 * HOUR, 2 * HOUR), null);
  assert.equal(P.computeNextRun_(0, 0, null, 0), null);
});

// ---------- end-to-end ----------
t('lists & chats commands', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  assert.match(e.cmd('/addchat -1001 news'), /List "news" does not exist/);
  assert.match(e.cmd('/addlist news'), /created/);
  assert.match(e.cmd('/addlist NEWS'), /already exists/);
  const r = e.cmd('/addchat -1001 -1002 -1003 -1005 @newsa news');
  assert.match(r, /✅ News A/); assert.match(r, /✅ Group B/); assert.match(r, /Post messages/); assert.match(r, /not a member/); assert.match(r, /already in the list/);
  assert.equal(D(e.sheets.Chats).length, 2);
  assert.equal(D(e.sheets.Chats)[0][1], '-1001'); // ID stays a string
  e.cmd('/addlist other'); e.cmd('/addchat -1001 other');
  assert.match(e.cmd('/removechat -1001 other'), /removed from: other/);
  e.cmd('/addchat -1001 other');
  assert.match(e.cmd('/removechat @newsa'), /news, other/);
  assert.equal(D(e.sheets.Chats).length, 1);
  assert.match(e.cmd('/lists'), /news<\/b> — chats: 1/);
  assert.match(e.cmd('/removelist news'), /Chats removed: 1/);
  assert.equal(D(e.sheets.Chats).length, 0);
});

t('non-admin rejected', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.world.gas.doPost(({ update_id: 9, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/addlist x' } }));
  assert.match(e.sent[0].text, /Access denied[\s\S]*7/); assert.equal(D(e.sheets.Lists).length, 0);
});

t('duplicate update ignored', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  const u = { update_id: 5, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/addlist a' } };
  e.world.gas.doPost(u); e.world.gas.doPost(u);
  assert.equal(D(e.sheets.Lists).length, 1);
});

t('regular job: example 1 schedule and end', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist news'); e.cmd('/addchat -1001 -1002 news');
  const r = e.cmd('/post hello hello -list news -start 24.10.2026 14:00 -regularity 2h -end 24.10.2026 18:00');
  assert.match(r, /Job #1/); assert.match(r, /Total posts: 3/);
  assert.equal(e.tick().length, 0);
  e.setNow(Date.UTC(2026, 9, 24, 11, 0) - 20e3); // 13:59:40
  let s = e.tick(); assert.equal(s.filter(x => x.text === 'hello hello').length, 2);
  assert.equal(e.tick().length, 0, 'no duplicate in same slot');
  e.setNow(Date.UTC(2026, 9, 24, 13, 0) + 5e3); assert.equal(e.tick().length, 2);
  e.setNow(Date.UTC(2026, 9, 24, 15, 0)); assert.equal(e.tick().filter(x => x.chat_id !== 42).length, 2);
  e.setNow(Date.UTC(2026, 9, 24, 17, 0)); assert.equal(e.tick().length, 0);
  const job = D(e.sheets.Jobs)[0]; assert.equal(job[1], 'done'); assert.equal(job[15], 3);
  assert.equal(D(e.sheets.Log).length, 6);
  assert.equal(D(e.sheets.Log)[0][7], 'https://t.me/newsa/' + D(e.sheets.Log)[0][6]);
  assert.equal(D(e.sheets.Log)[0][10], 'gas');
});

t('mix job: first all, then random N', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist news'); e.cmd('/addchat -1001 -1002 -1004 news');
  e.cmd('/post hi, andrew -list news -start now -mix 0.75h in 2');
  e.advance(10e3);
  assert.equal(e.tick().length, 3);
  for (let i = 0; i < 5; i++) { e.advance(45 * MIN); const s = e.tick(); assert.equal(s.length, 2); assert.notEqual(s[0].chat_id, s[1].chat_id); }
});

t('chat job + errors notify once + migration', () => {
  const tg = { chats: chats(), migrate: {} };
  const e = makeEnv({ tg });
  assert.match(e.cmd('/post x -chat -1003 -start now'), /Post messages/);
  e.cmd('/addlist l'); e.cmd('/addchat -1001 -1002 l');
  e.cmd('/post hey -list l -start now -regularity 1h');
  tg.chats['-1001'].kicked = true; tg.migrate['-1002'] = -1009;
  e.advance(5e3); let s = e.tickAll();
  const toAdmin = s.filter(x => x.chat_id === '42' || x.chat_id === 42);
  assert.equal(toAdmin.length, 1); assert.match(toAdmin[0].text, /kicked/);
  assert.ok(s.some(x => x.chat_id === '-1009'), 'resent to migrated id');
  assert.equal(D(e.sheets.Chats).find(r => r[2] === 'Group B')[1], '-1009');
  e.advance(HOUR); s = e.tickAll();
  assert.equal(s.filter(x => String(x.chat_id) === '42').length, 0, 'no repeated notification');
});

t('media caption copy & reply copy & jobs control', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 l');
  e.cmd(undefined, { caption: '/post <b>Photo</b> -list l -start now', caption_entities: [], photo: [{}] });
  e.cmd('/post -list l -start now', { reply_to_message: { message_id: 77 } });
  assert.match(e.cmd('/post text -list l', { reply_to_message: { message_id: 77 } }), /no text is needed/);
  e.advance(5e3); const s = e.tick();
  assert.equal(s[0].method, 'copyMessage'); assert.equal(s[0].caption, '<b>Photo</b>');
  assert.equal(s[1].method, 'copyMessage'); assert.equal(s[1].message_id, 77); assert.equal(s[1].caption, undefined);
  e.cmd('/post r -list l -start now -regularity 1h'); e.advance(5e3); e.tick();
  assert.match(e.cmd('/jobs'), /#3/);
  assert.match(e.cmd('/pausejob 3'), /⏸/);
  e.advance(3 * HOUR); assert.equal(e.tick().length, 0);
  assert.match(e.cmd('/resumejob 3'), /▶️/);
  e.advance(HOUR); assert.equal(e.tick().length, 1);
  assert.match(e.cmd('/stopjob 3'), /⏹/); e.advance(HOUR); assert.equal(e.tick().length, 0);
  assert.match(e.cmd('/stopjob 99'), /not found/);
});

t('removelist stops its jobs; formula-like text safe', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 l');
  e.cmd('/post =SUM(A1) -list l -start now -regularity 1h');
  assert.match(e.cmd('/removelist l'), /jobs stopped: 1/);
  e.advance(HOUR); assert.equal(e.tick().length, 0);
  assert.equal(JSON.parse(D(e.sheets.Jobs)[0][7]).text, '=SUM(A1)');
});

t('my_chat_member notification', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.world.gas.doPost(({ update_id: 1, my_chat_member: { chat: { id: -1007, type: 'channel', title: 'New' }, from: { id: 42 }, new_chat_member: { status: 'administrator', can_post_messages: true } } }));
  assert.match(e.sent[0].text, /-1007[\s\S]*yes ✅[\s\S]*\/addchat -1007/);
});


// ---------- regressions after refactoring ----------
t('cell_: every string is stored as text', () => {
  ['24.10.2026', 'TRUE', '1.50', '-1001', '=A1', 'Jan 5'].forEach(v => assert.equal(P.toCell_('str', v), "'" + v));
  assert.equal(P.toCell_('str', ''), ''); assert.equal(P.toCell_('num', 5), 5);
});
t('blank sheet rows are ignored', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 l');
  e.sheets.Chats.rows.splice(2, 0, ['', '', '', '', '', '']);
  e.cmd('/post x -list l -start now'); e.advance(5e3);
  assert.equal(e.tick().length, 1);
});
t('adjacent rows deleted in one call', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 -1002 -1004 l');
  e.ctx.__deleteCalls = 0; e.cmd('/removelist l');
  assert.equal(e.ctx.__deleteCalls, 2); // 1 for three chats, 1 for the list itself
});
t('permission check is batched (fetchAll), not one by one', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 -1002 -1004 l');
  e.ctx.__fetchAll = 0; e.ctx.__fetch = 0;
  assert.match(e.cmd('/checkchats l'), /3\/3 OK/);
  assert.equal(e.ctx.__fetchAll, 2); assert.equal(e.ctx.__fetch, 1); // getChat×3, getChatMember×3, reply
});
t('migration: -chat job ID is not reverted', () => {
  const tg = { chats: chats(), migrate: {} };
  const e = makeEnv({ tg });
  e.cmd('/post y -chat -1002 -start now -regularity 1h');
  tg.migrate['-1002'] = -1009; e.advance(5e3); e.tick();
  assert.equal(D(e.sheets.Jobs)[0][4], '-1009');
  delete tg.migrate['-1002']; e.advance(HOUR);
  assert.equal(e.tick()[0].chat_id, '-1009');
});
t('splitMessage_ cuts long lines', () => {
  const parts = P.splitMessage_('a\n' + 'x'.repeat(9000) + '\nb');
  assert.ok(parts.every(p => p.length <= 4000)); assert.equal(parts.join('').replace(/\n/g, '').length, 9002);
});
t('one-time post: delivery summary in notification', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 -1002 l');
  e.cmd('/post z -list l'); e.advance(5e3);
  const adm = e.tickAll().filter(x => String(x.chat_id) === '42');
  assert.match(adm[0].text, /delivered 2 of 2/);
});
t('no internal errors', () => { assert.deepEqual(env0.ctx.__errors, []); });
t('/version', () => { const e = makeEnv({ tg: { chats: chats() } }); assert.match(e.cmd('/version'), /v2\.0\.0/); });
t('upgrade from 1.0.0: existing sheets keep working, Log header gets the backend column', () => {
  const { createWorld: cw } = require('./lib/world');
  const w = cw(chats());
  w.setNow(Date.UTC(2026, 9, 20, 9, 0));
  const put = (name, rows) => { const sh = w.store.add(name); rows.forEach((r, i) => r.forEach((v, j) => w.store.set(sh, i + 1, j + 1, v))); };
  const now = new Date(Date.now());
  put('Lists', [['list_name', 'created_at'], ['l', now]]);
  put('Chats', [['list_name', 'chat_id', 'title', 'type', 'username', 'added_at'], ['l', '-1001', 'News A', 'channel', 'newsa', now]]);
  put('Jobs', [['job_id', 'status', 'kind', 'target_type', 'target', 'target_title', 'preview', 'payload', 'src_chat_id', 'src_msg_id', 'start', 'interval_min', 'end', 'mix_count', 'next_run', 'runs', 'last_run', 'last_error', 'created_at', 'created_by'],
    [7, 'active', 'text', 'list', 'l', '', 'old', '{"text":"old job","entities":[]}', '', '', now, 60, '', '', new Date(Date.now() + MIN), 3, now, '', now, '42']]);
  put('Log', [['time', 'job_id', 'run', 'target', 'chat_id', 'chat_title', 'message_id', 'link', 'status', 'error'], [now, 7, 3, 'list:l', '-1001', 'News A', 5, '', 'ok', '']]);
  w.gas.setup();
  assert.equal(w.store.sheet('Log').rows[0][10], 'backend');
  w.advance(2 * MIN); w.gas.tick();
  assert.equal(w.tg.sent.filter((x) => x.text === 'old job').length, 1);
  const jobs = D(w.store.sheet('Jobs'));
  assert.equal(jobs[0][15], 4);
  w.gas.doPost({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/post new -list l' } });
  assert.match(w.tg.adminMessages().slice(-1)[0], /Job #8/);
});
run();
