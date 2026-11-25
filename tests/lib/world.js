'use strict';
/**
 * Test world: one fake clock, one fake Telegram, one fake Google Sheet — shared by
 *   • the Apps Script backend (core + apps-script/*.gs in a vm context with GAS service mocks)
 *   • the server backend (real server/src code with SQLite in memory and a fake Sheets API)
 * so tests can switch the bot between backends and check what ends up in Telegram and in the sheet.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DateTime } = require('../../server/node_modules/luxon');

const ROOT = path.resolve(__dirname, '..', '..');
const TZ = 'Europe/Kiev';
const EPOCH_1899 = Date.UTC(1899, 11, 30);

// ------------------------------- clock -------------------------------
const clock = { now: Date.UTC(2026, 9, 20, 9, 0) }; // 20.10.2026 12:00 Kyiv
Date.now = () => clock.now;

// ---------------------------- fake Telegram ----------------------------
class FakeTelegram {
  constructor(chats) {
    this.chats = chats || {};
    this.migrate = {};
    this.sent = [];
    this.calls = [];
    this.webhook = null;
    this.pending = [];
    this.nextUpdateId = 1;
    this.gasDeliver = null;
  }
  fail(code, desc, params) { return { ok: false, error_code: code, description: desc, parameters: params }; }
  handle(method, p) {
    this.calls.push({ method, ...p });
    switch (method) {
      case 'sendMessage': case 'copyMessage': {
        this.sent.push({ method, ...p });
        const c = this.chats[p.chat_id];
        if (this.migrate[p.chat_id]) return this.fail(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: this.migrate[p.chat_id] });
        if (c && c.kicked) return this.fail(403, 'Forbidden: bot was kicked from the channel chat');
        return { ok: true, result: { message_id: this.sent.length + 100 } };
      }
      case 'getChat': {
        const c = this.chats[p.chat_id] || Object.values(this.chats).find((x) => '@' + x.username === p.chat_id);
        return c ? { ok: true, result: c } : this.fail(400, 'Bad Request: chat not found');
      }
      case 'getChatMember': {
        const c = Object.values(this.chats).find((x) => String(x.id) === String(p.chat_id));
        return { ok: true, result: c.me };
      }
      case 'setWebhook': this.webhook = p.url; return { ok: true, result: true };
      case 'deleteWebhook': this.webhook = null; return { ok: true, result: true };
      case 'getUpdates': {
        if (this.webhook) return this.fail(409, 'Conflict: can\'t use getUpdates method while webhook is active');
        if (p.offset) this.pending = this.pending.filter((u) => u.update_id >= p.offset);
        return { ok: true, result: this.pending.slice(0, p.limit || 100) };
      }
      default: return { ok: true, result: true };
    }
  }
  /** The admin (id 42) sends a message to the bot. Delivered via webhook if one is set, else queued for polling. */
  userSends(text, extra = {}) {
    const u = { update_id: this.nextUpdateId++, message: Object.assign({ message_id: this.nextUpdateId + 1000, chat: { id: 42, type: 'private' }, from: { id: 42 }, text }, extra) };
    this.pending.push(u);
    this.pump();
    return u;
  }
  /** Webhook delivery: Telegram pushes pending updates to the webhook in order. */
  pump() {
    while (this.webhook && this.gasDeliver && this.pending.length) this.gasDeliver(this.pending.shift());
  }
  adminMessages() { return this.sent.filter((s) => String(s.chat_id) === '42').map((s) => s.text); }
}

// ----------------------------- fake sheet store -----------------------------
class Store {
  constructor() { this.sheets = {}; this.timeCols = {}; this.nextId = 1; }
  sheet(name) { return this.sheets[name]; }
  add(name) { this.sheets[name] = { name, id: this.nextId++, rows: [] }; this.timeCols[name] = new Set(); return this.sheets[name]; }
  lastRow(sh) {
    for (let i = sh.rows.length - 1; i >= 0; i--) if ((sh.rows[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
    return 0;
  }
  set(sh, r, c, v) { while (sh.rows.length < r) sh.rows.push([]); const row = sh.rows[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  get(sh, r, c) { const row = sh.rows[r - 1] || []; const v = row[c - 1]; return v === undefined ? '' : v; }
}

const serialToDate = (s) => new Date(DateTime.fromMillis(Math.round(s * 86400000) + EPOCH_1899, { zone: 'UTC' }).setZone(TZ, { keepLocalTime: true }).toMillis());
const dateToSerial = (d) => { const l = DateTime.fromJSDate(d, { zone: TZ }); return (Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second, l.millisecond) - EPOCH_1899) / 86400000; };

// ------------------------------ GAS backend ------------------------------
function createGas(world) {
  const { store, tg } = world;
  const props = {};
  const cache = {};
  const counters = { fetch: 0, fetchAll: 0, deleteRows: 0 };

  const range = (sh, r, c, nr = 1, nc = 1) => ({
    setValues(v) {
      v.forEach((row, i) => row.forEach((x, j) => store.set(sh, r + i, c + j, (typeof x === 'string' && x[0] === "'") ? x.slice(1) : x)));
      return this;
    },
    setValue(x) { return this.setValues([[x]]); },
    getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(store.get(sh, r + i, c + j)); out.push(row); } return out; },
    setNumberFormat() { if (nc === 1) store.timeCols[sh.name].add(c); return this; },
    setFontWeight() { return this; }, setBackground() { return this; },
  });
  const sheetApi = (sh) => ({
    getLastRow: () => store.lastRow(sh),
    getMaxRows: () => Math.max(1000, sh.rows.length),
    getRange: (r, c, nr, nc) => range(sh, r, c, nr, nc),
    setFrozenRows() {},
    deleteRows(r, n) { counters.deleteRows++; sh.rows.splice(r - 1, n); },
  });
  const ss = {
    getSheetByName: (n) => (store.sheet(n) ? sheetApi(store.sheet(n)) : null),
    insertSheet: (n) => sheetApi(store.add(n)),
    setSpreadsheetTimeZone() {}, getSheets: () => Object.values(store.sheets), deleteSheet() {},
  };
  const resp = (r) => ({ getContentText: () => JSON.stringify(r), getResponseCode: () => 200 });
  const call = (url, params) => resp(tg.handle(url.split('/').pop(), JSON.parse(params.payload)));

  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => { ctx.__errors.push(a.join(' ')); if (process.env.SHOW_ERR) console.error('[gas]', ...a); } },
    __errors: [], __counters: counters,
    Date, Math, JSON, Object, Array, String, Number, RegExp, Error, isNaN, parseInt, parseFloat, Infinity,
    Session: { getScriptTimeZone: () => TZ },
    Utilities: {
      formatDate: (d, tz, f) => DateTime.fromJSDate(d, { zone: tz }).toFormat(f),
      parseDate: (s, tz, f) => { const dt = DateTime.fromFormat(s, f, { zone: tz }); if (!dt.isValid) throw new Error('Unparseable'); return new Date(dt.toMillis()); },
      sleep: (ms) => { clock.now += ms; }, getUuid: () => 'abc-def',
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    UrlFetchApp: {
      fetch: (u, p) => { counters.fetch++; return call(u, p); },
      fetchAll: (reqs) => { counters.fetchAll++; return reqs.map((r) => call(r.url, r)); },
    },
    HtmlService: { createHtmlOutput: (s) => s },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }), getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  };
  vm.createContext(ctx);
  const files = fs.readdirSync(path.join(ROOT, 'core')).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(ROOT, 'core', f))
    .concat(fs.readdirSync(path.join(ROOT, 'apps-script')).filter((f) => f.endsWith('.gs')).sort().map((f) => path.join(ROOT, 'apps-script', f)));
  files.forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }));
  props.BOT_TOKEN = '999:XYZ';
  props.ADMIN_IDS = '42';

  const gas = {
    ctx, props, counters,
    doPost: (u) => ctx.doPost({ parameter: { secret: props.WEBHOOK_SECRET }, postData: { contents: JSON.stringify(u) } }),
    tick: () => ctx.tick(),
    setup: () => ctx.setup(),
    setWebhook: () => ctx.setWebhook(),
  };
  tg.gasDeliver = (u) => gas.doPost(u);
  return gas;
}

// ------------------------------ fake Sheets API (server side) ------------------------------
function createFakeSheetsApi(store, stats) {
  const parse = (a1) => {
    const [name, ref] = a1.split('!');
    const m = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
    const col = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return { sh: store.sheet(name), name, c1: col(m[1]), r1: Number(m[2] || 1), c2: m[3] ? col(m[3]) : col(m[1]), r2: m[4] ? Number(m[4]) : null };
  };
  const toApi = (v) => (v instanceof Date ? dateToSerial(v) : v);
  return {
    async getSpreadsheet() { stats.calls++; const sheets = {}; Object.values(store.sheets).forEach((s) => { sheets[s.name] = s.id; }); return { timeZone: TZ, sheets }; },
    async batchGet(ranges) {
      stats.calls++;
      if (stats.down) throw new Error('Sheets API unavailable');
      return ranges.map((a1) => {
        const p = parse(a1);
        const r2 = p.r2 || store.lastRow(p.sh);
        const out = [];
        for (let r = p.r1; r <= r2; r++) {
          const row = [];
          for (let c = p.c1; c <= p.c2; c++) row.push(toApi(store.get(p.sh, r, c)));
          while (row.length && row[row.length - 1] === '') row.pop(); // the API trims trailing empty cells
          out.push(row);
        }
        while (out.length && !out[out.length - 1].length) out.pop(); // …and trailing empty rows
        return out;
      });
    },
    async batchUpdate(data) {
      stats.calls++;
      if (stats.down) throw new Error('Sheets API unavailable');
      data.forEach(({ range, values }) => {
        const p = parse(range);
        values.forEach((row, i) => row.forEach((v, j) => {
          const c = p.c1 + j;
          store.set(p.sh, p.r1 + i, c, typeof v === 'number' && store.timeCols[p.name].has(c) ? serialToDate(v) : v); // RAW into a date-formatted cell
        }));
      });
    },
    async batchClear(ranges) {
      stats.calls++;
      ranges.forEach((a1) => { const p = parse(a1); for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) store.set(p.sh, r, c, ''); });
    },
    async append(a1, values) {
      stats.calls++;
      const p = parse(a1);
      const start = store.lastRow(p.sh) + 1;
      values.forEach((row, i) => row.forEach((v, j) => store.set(p.sh, start + i, j + 1, typeof v === 'number' && store.timeCols[p.name].has(j + 1) ? serialToDate(v) : v)));
    },
    async formatCells(requests) {
      stats.calls++;
      requests.forEach((r) => {
        const name = Object.values(store.sheets).find((s) => s.id === r.repeatCell.range.sheetId).name;
        store.timeCols[name].add(r.repeatCell.range.startColumnIndex + 1);
      });
    },
  };
}

// ------------------------------ server backend ------------------------------
function createServer(world) {
  const { Db } = require('../../server/src/db');
  const { SheetsStore } = require('../../server/src/sheets');
  const { Backend } = require('../../server/src/backend');
  const { createTelegram } = require('../../server/src/telegram');
  const { loadCore, coreValue } = require('../../server/src/core');
  loadCore();
  const stats = { calls: 0, down: false };
  const api = createFakeSheetsApi(world.store, stats);
  const sheets = new SheetsStore(api, { SCHEMA: coreValue('SCHEMA'), CONTROL_SHEET: coreValue('CONTROL_SHEET'), CONTROL_KEYS: coreValue('CONTROL_KEYS') });
  const fetchImpl = async (url, opts) => {
    const r = world.tg.handle(url.split('/').pop(), JSON.parse(opts.body));
    return { status: 200, text: async () => JSON.stringify(r) };
  };
  const tg = createTelegram({ token: '999:XYZ', fetchImpl });
  const errors = [];
  const logger = { log() {}, error: (m) => { errors.push(m); if (process.env.SHOW_ERR) console.error('[server]', m); } };
  const backend = new Backend({
    db: new Db(':memory:', coreValue('SCHEMA')), sheets, tg, logger,
    secrets: { BOT_TOKEN: '999:XYZ', ADMIN_IDS: '42' },
    sleep: async (ms) => { clock.now += ms; },
  });
  return { backend, sheets, stats, errors, async init() { await sheets.init(); } };
}

function createWorld(chats) {
  const world = { clock, store: new Store(), tg: new FakeTelegram(chats) };
  world.gas = createGas(world);
  world.createServer = () => createServer(world);
  world.advance = (ms) => { clock.now += ms; };
  world.setNow = (t) => { clock.now = t; };
  world.data = (name) => (world.store.sheet(name) ? world.store.sheet(name).rows.slice(1).filter((r) => r.some((v) => v !== '')) : []);
  return world;
}

function defaultChats() {
  return {
    '-1001': { id: -1001, type: 'channel', title: 'News A', username: 'newsa', me: { status: 'administrator', can_post_messages: true } },
    '-1002': { id: -1002, type: 'supergroup', title: 'Group B', me: { status: 'member' }, permissions: { can_send_messages: true } },
    '-1003': { id: -1003, type: 'channel', title: 'C no rights', me: { status: 'administrator', can_post_messages: false } },
    '-1004': { id: -1004, type: 'supergroup', title: 'Group D', me: { status: 'member' }, permissions: { can_send_messages: true } },
    '-1005': { id: -1005, type: 'channel', title: 'Not member', me: { status: 'left' } },
  };
}

/** Minimal test runner (async-aware). */
function runner() {
  let pass = 0, fail = 0;
  const queue = [];
  return {
    t: (name, fn) => queue.push([name, fn]),
    async run() {
      for (const [name, fn] of queue) {
        try { await fn(); pass++; console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '\n ', e && e.stack); }
      }
      console.log(`\n${pass} passed, ${fail} failed`);
      if (fail) process.exitCode = 1;
    },
  };
}

module.exports = { createWorld, defaultChats, runner, clock, TZ };
