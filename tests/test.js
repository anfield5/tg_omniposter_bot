const assert = require('assert');
const { makeEnv } = require('./harness');
const D = sh => sh.rows.slice(1);
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('✓', name); } catch (e) { console.log('✗', name, '\n ', e.message); process.exitCode = 1; } };
const HOUR = 3600e3, MIN = 60e3;

const chats = () => ({
  '-1001': { id: -1001, type: 'channel', title: 'News A', username: 'newsa', me: { status: 'administrator', can_post_messages: true } },
  '-1002': { id: -1002, type: 'supergroup', title: 'Group B', me: { status: 'member' }, permissions: { can_send_messages: true } },
  '-1003': { id: -1003, type: 'channel', title: 'C no rights', me: { status: 'administrator', can_post_messages: false } },
  '-1004': { id: -1004, type: 'supergroup', title: 'Group D', me: { status: 'member' }, permissions: { can_send_messages: true } },
  '-1005': { id: -1005, type: 'channel', title: 'Not member', me: { status: 'left' } },
});

// ---------- pure parser ----------
const env0 = makeEnv({ tg: { chats: chats() } });
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
  const r = P.parsePostArgs_('/post hello hello -list newschannels -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00', [], env0.now(), 'x');
  assert.equal(r.text, 'hello hello'); assert.equal(r.target.value, 'newschannels'); assert.equal(r.interval, 120);
  assert.equal(P.countRuns_(r.startMs, r.interval, r.endMs), 396);
});
t('parse example 2 (mix)', () => {
  const r = P.parsePostArgs_('/post hi, andrew -list newschannels -start 24.10.2026 14:00 -mix 0.75h in 2', [], env0.now(), 'x');
  assert.equal(r.text, 'hi, andrew'); assert.equal(r.interval, 45); assert.equal(r.mixCount, 2); assert.equal(r.endMs, null);
});
t('parse example 3 (chat, quotes, em-dash)', () => {
  const r = P.parsePostArgs_('/post hi, andrew —chat -1001 -start "24.10.2026 14:00" -regularity 2h -end 26.11.2026 12:00', [], env0.now(), 'x');
  assert.equal(r.target.type, 'chat'); assert.equal(r.target.value, '-1001');
});
t('multiline + entities shift', () => {
  const raw = '/post  Hello *bold*\nline2 -list x';
  const ents = [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'bold', offset: 13, length: 6 }];
  const r = P.parsePostArgs_(raw, ents, env0.now(), 'x');
  assert.equal(r.text, 'Hello *bold*\nline2'); assert.equal(r.entities.length, 1);
  assert.equal(r.text.substr(r.entities[0].offset, r.entities[0].length), '*bold*');
});
t('validation errors', () => {
  const n = env0.now();
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
  e.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({ update_id: 9, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/addlist x' } }) } });
  assert.match(e.sent[0].text, /Access denied[\s\S]*7/); assert.ok(!e.sheets.Lists);
});

t('duplicate update ignored', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  const u = JSON.stringify({ update_id: 5, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/addlist a' } });
  e.ctx.doPost({ parameter: {}, postData: { contents: u } }); e.ctx.doPost({ parameter: {}, postData: { contents: u } });
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
  e.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({ update_id: 1, my_chat_member: { chat: { id: -1007, type: 'channel', title: 'New' }, from: { id: 42 }, new_chat_member: { status: 'administrator', can_post_messages: true } } }) } });
  assert.match(e.sent[0].text, /-1007[\s\S]*yes ✅[\s\S]*\/addchat -1007/);
});


// ---------- regressions after refactoring ----------
t('cell_: every string is stored as text', () => {
  ['24.10.2026', 'TRUE', '1.50', '-1001', '=A1', 'Jan 5'].forEach(v => assert.equal(P.cell_(v), "'" + v));
  assert.equal(P.cell_(''), ''); assert.equal(P.cell_(5), 5);
});
t('blank sheet rows are ignored', () => {
  const e = makeEnv({ tg: { chats: chats() } });
  e.cmd('/addlist l'); e.cmd('/addchat -1001 l');
  e.sheets.Chats.rows.push(['', '', '', '', '', '']);
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
t('/version', () => { const e = makeEnv({ tg: { chats: chats() } }); assert.match(e.cmd('/version'), /v1\.0\.0/); });
console.log(`\n${pass} passed`);
