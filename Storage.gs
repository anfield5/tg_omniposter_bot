/**
 * ======================== STORAGE: GOOGLE SHEETS ========================
 * The spreadsheet the script is bound to is both the database and the post log.
 *
 *   Lists — lists
 *   Chats — list ↔ chat links (one chat can belong to several lists)
 *   Jobs  — post templates / schedules
 *   Log   — every delivery with message_id and link
 *
 * Reads are cached within ONE script execution (one command / one tick)
 * and dropped on any write to that sheet. There is no cache between executions,
 * so manual edits to the spreadsheet are always picked up.
 */

const SHEET_DEFS = {
  lists: { name: 'Lists', key: 'list_name', headers: ['list_name', 'created_at'] },
  chats: { name: 'Chats', key: 'chat_id', headers: ['list_name', 'chat_id', 'title', 'type', 'username', 'added_at'] },
  jobs: {
    name: 'Jobs', key: 'job_id',
    headers: ['job_id', 'status', 'kind', 'target_type', 'target', 'target_title', 'preview', 'payload',
      'src_chat_id', 'src_msg_id', 'start', 'interval_min', 'end', 'mix_count', 'next_run', 'runs',
      'last_run', 'last_error', 'created_at', 'created_by'],
  },
  log: { name: 'Log', key: 'time', headers: ['time', 'job_id', 'run', 'target', 'chat_id', 'chat_title', 'message_id', 'link', 'status', 'error'] },
};

const _sheetCache = {};
const _rowsCache = {};

function ss_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  const id = prop_('SPREADSHEET_ID');
  if (!id) throw new Error('The script is not bound to a spreadsheet and SPREADSHEET_ID is not set');
  return SpreadsheetApp.openById(id);
}

function sheet_(key) {
  if (_sheetCache[key]) return _sheetCache[key];
  const def = SHEET_DEFS[key];
  const ss = ss_();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
  }
  _sheetCache[key] = sh;
  return sh;
}

/**
 * Every string is written with a leading ' — the "text" marker in Sheets (the apostrophe itself isn't stored).
 * Otherwise Sheets "helpfully" converts strings into formulas (=…), numbers (-100123…, 1.50), dates (24.10.2026)
 * and booleans (TRUE), corrupting the data.
 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return v;
}

function readAll_(key) {
  if (!_rowsCache[key]) {
    const sh = sheet_(key);
    const def = SHEET_DEFS[key];
    const last = sh.getLastRow();
    const rows = [];
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, def.headers.length).getValues().forEach(function (r, i) {
        const o = { _row: i + 2 };
        def.headers.forEach(function (h, j) { o[h] = r[j]; });
        if (o[def.key] !== '' && o[def.key] !== null) rows.push(o); // skip blank / manually inserted rows
      });
    }
    _rowsCache[key] = rows;
  }
  // return copies so callers can mutate objects without corrupting the cache
  return _rowsCache[key].map(function (o) { return Object.assign({}, o); });
}

function dropCache_(key) { delete _rowsCache[key]; }

function toRow_(key, obj) {
  return SHEET_DEFS[key].headers.map(function (h) { return cell_(obj[h]); });
}

function appendRows_(key, objs) {
  if (!objs.length) return;
  const sh = sheet_(key);
  const rows = objs.map(function (o) { return toRow_(key, o); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  dropCache_(key);
}

function updateRow_(key, obj) {
  if (!obj._row) throw new Error('updateRow_: missing _row');
  const row = toRow_(key, obj);
  sheet_(key).getRange(obj._row, 1, 1, row.length).setValues([row]);
  dropCache_(key);
}

/** Deletes rows: adjacent rows are removed with a single deleteRows call (bottom-up). */
function deleteRows_(key, objs) {
  if (!objs.length) return;
  const sh = sheet_(key);
  const rows = objs.map(function (o) { return o._row; }).sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], i === j ? 1 : rows[i] - rows[j] + 1);
    i = j + 1;
  }
  dropCache_(key);
}

/** All data changes run under the script lock so the webhook and scheduler don't interfere. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new UserError('The bot is busy (sending posts). Try again in a minute.');
  try {
    // another execution may have changed the sheet while we waited for the lock
    Object.keys(_rowsCache).forEach(dropCache_);
    return fn();
  } finally { lock.releaseLock(); }
}

// ----------------------------- Lists / Chats -----------------------------

function lc_(s) { return String(s).trim().toLowerCase(); }

function findList_(name) {
  const n = lc_(name);
  return readAll_('lists').filter(function (l) { return lc_(l.list_name) === n; })[0] || null;
}

function requireList_(name) {
  const l = findList_(name);
  if (!l) throw new UserError('List "' + esc_(name) + '" does not exist. Create it: <code>/addlist ' + esc_(name) + '</code>');
  return l;
}

function chatsInList_(name) {
  const n = lc_(name);
  return readAll_('chats').filter(function (c) { return lc_(c.list_name) === n; });
}

/** Does a chat row match the user's input: numeric ID or @username. */
function chatMatches_(row, ref) {
  ref = String(ref).trim();
  if (String(row.chat_id) === ref) return true;
  return ref.charAt(0) === '@' && !!row.username && lc_('@' + row.username) === lc_(ref);
}

/** A group was upgraded to a supergroup — update the ID everywhere (in-memory jobs are updated by the caller). */
function migrateChatId_(oldId, newId) {
  readAll_('chats').forEach(function (c) {
    if (String(c.chat_id) === String(oldId)) { c.chat_id = String(newId); c.type = 'supergroup'; updateRow_('chats', c); }
  });
  readAll_('jobs').forEach(function (j) {
    if (j.target_type === 'chat' && String(j.target) === String(oldId)) { j.target = String(newId); updateRow_('jobs', j); }
  });
}

// --------------------------------- Jobs ---------------------------------

function nextJobId_() {
  const n = Number(prop_('JOB_SEQ') || 0) + 1;
  setProp_('JOB_SEQ', n);
  return n;
}

function toMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** Sheet row → job object with convenient *_ms fields. */
function hydrateJob_(j) {
  j.job_id = Number(j.job_id);
  j.runs = Number(j.runs) || 0;
  j.interval_min = Number(j.interval_min) || 0;
  j.mix_count = Number(j.mix_count) || 0;
  j.target = String(j.target);
  j.next_run_ms = toMs_(j.next_run);
  j.end_ms = toMs_(j.end);
  j.start_ms = toMs_(j.start);
  try { j.payloadObj = j.payload ? JSON.parse(j.payload) : {}; } catch (e) { j.payloadObj = {}; }
  return j;
}

function readJobs_() { return readAll_('jobs').map(hydrateJob_); }

function saveJob_(j) {
  j.next_run = j.next_run_ms ? new Date(j.next_run_ms) : '';
  j.end = j.end_ms ? new Date(j.end_ms) : '';
  j.start = j.start_ms ? new Date(j.start_ms) : '';
  j.last_error = String(j.last_error || '').slice(0, 500);
  updateRow_('jobs', j);
}

function findJob_(idArg) {
  const id = Number(String(idArg || '').replace(/^#/, '').trim());
  if (!id) throw new UserError('Specify a job number, e.g. <code>/stopjob 12</code>');
  const job = readJobs_().filter(function (j) { return j.job_id === id; })[0];
  if (!job) throw new UserError('Job #' + id + ' not found');
  return job;
}

function isLive_(j) { return j.status === 'active' || j.status === 'paused'; }
