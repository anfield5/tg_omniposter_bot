// End-to-end harness: loads .gs files into a VM with in-memory mocks of Apps Script services and Telegram.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..');
const OFFSET = 3 * 3600 * 1000; // Europe/Kiev in Oct (before DST end) — enough for tests

function fmt(d) { const x = new Date(d.getTime() + OFFSET); const p = n => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}.${p(x.getUTCMonth() + 1)}.${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`; }

function makeEnv(opts = {}) {
  let clock = opts.now || Date.UTC(2026, 9, 20, 9, 0); // 20.10.2026 12:00 Kyiv
  const props = {}; const cache = {}; const sheets = {}; const sent = []; const tgState = opts.tg || {};
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(clock); else super(...a); } static now() { return clock; } }

  function mkSheet(name) {
    const rows = [];
    const sh = {
      name, rows,
      getLastRow: () => rows.length,
      getRange: (r, c, nr, nc) => ({
        setValues(v) { for (let i = 0; i < v.length; i++) { rows[r - 1 + i] = v[i].map(x => (typeof x === 'string' && x[0] === "'") ? x.slice(1) : x); } return this; },
        getValues() { const out = []; for (let i = 0; i < nr; i++) out.push(rows[r - 1 + i].slice(0, nc)); return out; },
        setFontWeight() { return this; }, setBackground() { return this; },
      }),
      setFrozenRows() {}, deleteRows(r, n) { ctx.__deleteCalls++; rows.splice(r - 1, n); },
    };
    return sh;
  }
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n)), setSpreadsheetTimeZone() {}, getSheets: () => Object.values(sheets), deleteSheet() {} };

  function telegram(method, p) {
    const fail = (code, desc, params) => ({ ok: false, error_code: code, description: desc, parameters: params });
    if (method === 'sendMessage' || method === 'copyMessage') {
      sent.push({ method, ...p });
      const c = tgState.chats && tgState.chats[p.chat_id];
      if (tgState.migrate && tgState.migrate[p.chat_id]) return fail(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: tgState.migrate[p.chat_id] });
      if (c && c.kicked) return fail(403, 'Forbidden: bot was kicked from the channel chat');
      return { ok: true, result: { message_id: sent.length + 100 } };
    }
    if (method === 'getChat') {
      const c = tgState.chats && (tgState.chats[p.chat_id] || Object.values(tgState.chats).find(x => '@' + x.username === p.chat_id));
      return c ? { ok: true, result: c } : fail(400, 'Bad Request: chat not found');
    }
    if (method === 'getChatMember') { const c = Object.values(tgState.chats).find(x => String(x.id) === String(p.chat_id)); return { ok: true, result: c.me }; }
    return { ok: true, result: true };
  }
  const resp = r => ({ getContentText: () => JSON.stringify(r), getResponseCode: () => 200 });
  const parseReq = (url, params) => { const method = url.split('/').pop(); return telegram(method, JSON.parse(params.payload)); };

  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => { ctx.__errors.push(a.join(' ')); if (process.env.SHOW_ERR) console.error('[gas error]', ...a); } }, __errors: [], __deleteCalls: 0, __fetch: 0, __fetchAll: 0,
    Date: FakeDate, Math, JSON, Object, Array, String, Number, RegExp, Error, isNaN, parseInt, parseFloat, Infinity,
    Session: { getScriptTimeZone: () => 'Europe/Kiev' },
    Utilities: {
      formatDate: (d, tz, f) => fmt(d),
      parseDate: (s, tz, f) => { const m = s.match(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+)/); return new RealDate(RealDate.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) - OFFSET); },
      sleep: ms => { clock += ms; }, getUuid: () => 'abc-def',
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    UrlFetchApp: { fetch: (u, p) => { ctx.__fetch++; return resp(parseReq(u, p)); }, fetchAll: reqs => { ctx.__fetchAll++; return reqs.map(r => resp(parseReq(r.url, r))); } },
    HtmlService: { createHtmlOutput: s => s },
    ScriptApp: {},
  };
  vm.createContext(ctx);
  for (const f of ['Config.gs', 'Telegram.gs', 'Storage.gs', 'Parser.gs', 'Scheduler.gs', 'Commands.gs', 'Main.gs'])
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  props.BOT_TOKEN = '999:XYZ'; props.ADMIN_IDS = '42';
  let uid = 1, mid = 1;
  return {
    ctx, props, sheets, sent,
    advance: ms => { clock += ms; }, setNow: t => { clock = t; }, now: () => clock,
    cmd(text, extra = {}) { const before = sent.length;
      ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({ update_id: uid++, message: Object.assign({ message_id: mid++, chat: { id: 42, type: 'private' }, from: { id: 42 }, text }, extra) }) } });
      return sent.slice(before).filter(s => String(s.chat_id) === '42').map(s => s.text).join('\n---\n'); },
    tickAll() { const b = sent.length; ctx.tick(); return sent.slice(b); },
    tick() { return this.tickAll().filter(s => String(s.chat_id) !== '42'); },
  };
}
module.exports = { makeEnv, fmt };
