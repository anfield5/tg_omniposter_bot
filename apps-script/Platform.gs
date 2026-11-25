/**
 * ===================== APPS SCRIPT PLATFORM ADAPTER =====================
 * Implements the PLATFORM contract from core/ on top of Google Apps Script:
 *   storage   → Google Sheets (the spreadsheet this script is bound to)
 *   effects   → synchronous driver (UrlFetchApp)
 *   lock      → LockService script lock
 *   props     → Script Properties (BOT_TOKEN, ADMIN_IDS, WEBAPP_URL, …)
 */

const PLATFORM = {
  name: 'gas',
  tzName: function () { return Session.getScriptTimeZone(); },
  tzParse: gasTzParse_,
  tzFormat: function (ms, fmt) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), fmt); },
  getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
  setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
  secret: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
  lock: gasLock_,
  unlock: gasUnlock_,
  log: function (level, msg) { (level === 'error' ? console.error : console.log)(msg); },
  db: {
    all: function (t) { return gasRead_(t).map(function (o) { return Object.assign({}, o); }); },
    insert: gasInsert_,
    update: gasUpdate_,
    remove: gasRemove_,
  },
};

function gasTzParse_(s, fmt) {
  try { return Utilities.parseDate(s, Session.getScriptTimeZone(), fmt).getTime(); } catch (e) { return null; }
}

// --------------------------------- Lock ---------------------------------

let _gasLock = null;
let _gasLockDepth = 0;

/** Re-entrant within one execution. Acquiring the lock drops the read cache (others may have written). */
function gasLock_(waitMs) {
  if (_gasLockDepth > 0) { _gasLockDepth++; return true; }
  const l = LockService.getScriptLock();
  if (!l.tryLock(waitMs)) return false;
  _gasLock = l;
  _gasLockDepth = 1;
  gasDropCache_();
  return true;
}

function gasUnlock_() {
  if (_gasLockDepth === 0) return;
  if (--_gasLockDepth === 0) { _gasLock.releaseLock(); _gasLock = null; }
}

// ------------------------------- Effects --------------------------------

/** Runs a core generator to completion, executing its effects synchronously. */
function runE_(gen) {
  let r = gen.next();
  while (!r.done) {
    let res, err = null;
    try { res = gasEffect_(r.value); } catch (e) { err = e; }
    r = err ? gen.throw(err) : gen.next(res);
  }
  return r.value;
}

function gasEffect_(eff) {
  switch (eff.t) {
    case 'tg': return gasTg_(eff.method, eff.payload);
    case 'batch': return gasTgBatch_(eff.calls);
    case 'sleep': Utilities.sleep(eff.ms); return undefined;
    case 'checkpoint': return undefined; // Sheets *is* the storage here — nothing to flush
    case 'getControl': return readControl_();
    case 'handover': return gasHandover_(eff.to, eff.by);
    default: throw new Error('Unknown effect: ' + eff.t);
  }
}

function tgUrl_(method) { return 'https://api.telegram.org/bot' + getToken_() + '/' + method; }

function tgParams_(payload) {
  return { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true };
}

function tgParse_(res) {
  try { return JSON.parse(res.getContentText()); } catch (e) {
    return { ok: false, error_code: res.getResponseCode(), description: 'Bad response: ' + res.getContentText().slice(0, 200) };
  }
}

function gasTg_(method, payload) {
  try { return tgParse_(UrlFetchApp.fetch(tgUrl_(method), tgParams_(payload))); } catch (e) {
    return { ok: false, error_code: 0, description: 'Network: ' + e.message };
  }
}

function gasTgBatch_(calls) {
  const reqs = calls.map(function (c) { const p = tgParams_(c.payload); p.url = tgUrl_(c.method); return p; });
  try { return UrlFetchApp.fetchAll(reqs).map(tgParse_); } catch (e) {
    // fetchAll fails as a whole on a network error — fall back to sequential requests
    return calls.map(function (c) { return gasTg_(c.method, c.payload); });
  }
}

/** Synchronous Bot API call for setup functions; throws on error. */
function tgCall_(method, payload) { return runE_(tgCallE_(method, payload)); }

// ------------------------------- Sheets DB --------------------------------

const _gasSheets = {};
const _gasRows = {};

function ss_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  const id = PLATFORM.getProp('SPREADSHEET_ID');
  if (!id) throw new Error('The script is not bound to a spreadsheet and SPREADSHEET_ID is not set');
  return SpreadsheetApp.openById(id);
}

function colsOf_(table) { return Object.keys(SCHEMA[table].cols); }

function sheet_(table) {
  if (_gasSheets[table]) return _gasSheets[table];
  const def = SCHEMA[table];
  const ss = ss_();
  let sh = ss.getSheetByName(def.sheet);
  if (!sh) {
    sh = ss.insertSheet(def.sheet);
    const cols = colsOf_(table);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
  }
  _gasSheets[table] = sh;
  return sh;
}

/** (Re)writes the header row — picks up columns added in newer versions (always appended at the end). */
function writeHeader_(table) {
  const cols = colsOf_(table);
  sheet_(table).getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8eaed');
}

/** Time columns get a date format, so numbers written by the server (serial dates) display as dates. */
function formatTimeColumns_(table) {
  const sh = sheet_(table);
  colsOf_(table).forEach(function (c, i) {
    if (SCHEMA[table].cols[c] === 'time') sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  });
}

function gasDropCache_() { Object.keys(_gasRows).forEach(function (k) { delete _gasRows[k]; }); }

/** Serial date (days since 1899-12-30, local wall time) → epoch ms in the script time zone. */
function serialToMs_(serial) {
  const wall = new Date(Math.round(serial * 86400000) + Date.UTC(1899, 11, 30));
  return gasTzParse_(Utilities.formatDate(wall, 'UTC', 'yyyy-MM-dd HH:mm:ss'), 'yyyy-MM-dd HH:mm:ss');
}

function fromCell_(type, v) {
  if (v === '' || v === null || v === undefined) return type === 'str' ? '' : null;
  if (type === 'time') {
    if (v instanceof Date) return v.getTime();
    const n = Number(v);
    if (isNaN(n)) return null;
    return n < 1e7 ? serialToMs_(n) : n; // tolerate an unformatted serial or raw epoch ms
  }
  if (type === 'num') { const n = Number(v); return isNaN(n) ? null : n; }
  return String(v);
}

/**
 * Every string is written with a leading ' — the "text" marker in Sheets (the apostrophe itself isn't stored).
 * Otherwise Sheets converts strings into formulas (=…), numbers (-100123…), dates (24.10.2026), booleans (TRUE).
 */
function toCell_(type, v) {
  if (v === undefined || v === null || v === '') return '';
  if (type === 'time') return new Date(Number(v));
  if (type === 'num') return Number(v);
  return "'" + String(v);
}

function gasRead_(table) {
  if (!_gasRows[table]) {
    const sh = sheet_(table);
    const cols = colsOf_(table);
    const types = SCHEMA[table].cols;
    const key = SCHEMA[table].key;
    const last = sh.getLastRow();
    const rows = [];
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, cols.length).getValues().forEach(function (r, i) {
        if (r[cols.indexOf(key)] === '' || r[cols.indexOf(key)] === null) return; // skip blank / manual rows
        const o = { _id: i + 2 };
        cols.forEach(function (c, j) { o[c] = fromCell_(types[c], r[j]); });
        rows.push(o);
      });
    }
    _gasRows[table] = rows;
  }
  return _gasRows[table];
}

function toRow_(table, obj) {
  const types = SCHEMA[table].cols;
  return colsOf_(table).map(function (c) { return toCell_(types[c], obj[c]); });
}

function gasInsert_(table, objs) {
  const sh = sheet_(table);
  const rows = objs.map(function (o) { return toRow_(table, o); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  delete _gasRows[table];
}

function gasUpdate_(table, obj) {
  if (!obj._id) throw new Error('update: missing _id');
  const row = toRow_(table, obj);
  sheet_(table).getRange(obj._id, 1, 1, row.length).setValues([row]);
  delete _gasRows[table];
}

/** Adjacent rows are removed with a single deleteRows call (bottom-up). */
function gasRemove_(table, objs) {
  const sh = sheet_(table);
  const rows = objs.map(function (o) { return o._id; }).sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], i === j ? 1 : rows[i] - rows[j] + 1);
    i = j + 1;
  }
  delete _gasRows[table];
}

// ------------------------------ Control sheet ------------------------------

function controlSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CONTROL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONTROL_SHEET);
    const rows = [['key', 'value']].concat(CONTROL_KEYS.map(function (k) { return [k, k === 'active_backend' ? 'gas' : k === 'epoch' ? 0 : '']; }));
    sh.getRange(1, 1, rows.length, 2).setValues(rows);
    sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** → {active_backend, epoch, server_heartbeat (ms), server_version, switched_at (ms), switched_by, gas_webhook_url} */
function readControl_() {
  const vals = controlSheet_().getRange(2, 2, CONTROL_KEYS.length, 1).getValues();
  const ctl = {};
  CONTROL_KEYS.forEach(function (k, i) {
    const v = vals[i][0];
    ctl[k] = (k === 'epoch' || k === 'server_heartbeat' || k === 'switched_at') ? (v === '' ? null : Number(v)) : String(v);
  });
  return ctl;
}

function writeControl_(patch) {
  const sh = controlSheet_();
  Object.keys(patch).forEach(function (k) {
    const i = CONTROL_KEYS.indexOf(k);
    if (i === -1) throw new Error('Unknown control key: ' + k);
    const v = patch[k];
    sh.getRange(i + 2, 2).setValue(typeof v === 'string' && v !== '' ? "'" + v : v);
  });
}

/** Apps Script hands the bot over to the server: flip the flag, release Telegram ingress. */
function gasHandover_(to, by) {
  if (to !== 'server') throw new Error('Apps Script can only hand over to the server');
  const ctl = readControl_();
  writeControl_({ active_backend: 'server', epoch: (ctl.epoch || 0) + 1, switched_at: Date.now(), switched_by: by });
  gasTg_('deleteWebhook', { drop_pending_updates: false }); // pending updates stay queued for the server
  PLATFORM.setProp('LAST_ACTIVE', 'server');
  return '✅ Apps Script released the bot.';
}
