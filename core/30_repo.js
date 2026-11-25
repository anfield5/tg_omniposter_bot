/**
 * ============================== REPOSITORY ==============================
 * Domain-level data access on top of PLATFORM.db (Sheets in Apps Script, SQLite on the server).
 *
 * PLATFORM.db contract:
 *   all(table)            → array of row copies: {_id, ...columns}; time = epoch ms | null, num = number | null
 *   insert(table, rows)   → appends rows
 *   update(table, row)    → overwrites the row with row._id
 *   remove(table, rows)   → deletes rows by _id
 */

function rows_(table) { return PLATFORM.db.all(table); }
function insert_(table, rows) { if (rows.length) PLATFORM.db.insert(table, rows); }
function update_(table, row) { PLATFORM.db.update(table, row); }
function remove_(table, rows) { if (rows.length) PLATFORM.db.remove(table, rows); }

/**
 * All data changes run under a lock so incoming commands and the scheduler don't interfere.
 * PLATFORM.lock(waitMs) → bool, PLATFORM.unlock(). fn must be synchronous (no effects inside).
 */
function withLock_(fn) {
  if (!PLATFORM.lock(30000)) throw new UserError('The bot is busy (sending posts). Try again in a minute.');
  try { return fn(); } finally { PLATFORM.unlock(); }
}

// ----------------------------- Lists / Chats -----------------------------

function findList_(name) {
  const n = lc_(name);
  return rows_('lists').filter(function (l) { return lc_(l.list_name) === n; })[0] || null;
}

function requireList_(name) {
  const l = findList_(name);
  if (!l) throw new UserError('List "' + esc_(name) + '" does not exist. Create it: <code>/addlist ' + esc_(name) + '</code>');
  return l;
}

function chatsInList_(name) {
  const n = lc_(name);
  return rows_('chats').filter(function (c) { return lc_(c.list_name) === n; });
}

/** Does a chat row match the user's input: numeric ID or @username. */
function chatMatches_(row, ref) {
  ref = String(ref).trim();
  if (String(row.chat_id) === ref) return true;
  return ref.charAt(0) === '@' && !!row.username && lc_('@' + row.username) === lc_(ref);
}

/** A group was upgraded to a supergroup — update the ID everywhere (in-memory jobs are updated by the caller). */
function migrateChatId_(oldId, newId) {
  rows_('chats').forEach(function (c) {
    if (String(c.chat_id) === String(oldId)) { c.chat_id = String(newId); c.type = 'supergroup'; update_('chats', c); }
  });
  rows_('jobs').forEach(function (j) {
    if (j.target_type === 'chat' && String(j.target) === String(oldId)) { j.target = String(newId); update_('jobs', j); }
  });
}

// --------------------------------- Jobs ---------------------------------

/** Job IDs are max+1 of the shared table, so they never collide after switching backends. */
function nextJobId_() {
  let max = 0;
  rows_('jobs').forEach(function (j) { if (Number(j.job_id) > max) max = Number(j.job_id); });
  return max + 1;
}

/** Row → job object with normalized types and parsed payload. */
function hydrateJob_(j) {
  j.job_id = Number(j.job_id);
  j.runs = Number(j.runs) || 0;
  j.interval_min = Number(j.interval_min) || 0;
  j.mix_count = Number(j.mix_count) || 0;
  j.target = String(j.target);
  try { j.payloadObj = j.payload ? JSON.parse(j.payload) : {}; } catch (e) { j.payloadObj = {}; }
  return j;
}

function readJobs_() { return rows_('jobs').map(hydrateJob_); }

function saveJob_(j) {
  j.last_error = String(j.last_error || '').slice(0, 500);
  update_('jobs', j);
}

function findJob_(idArg) {
  const id = Number(String(idArg || '').replace(/^#/, '').trim());
  if (!id) throw new UserError('Specify a job number, e.g. <code>/stopjob 12</code>');
  const job = readJobs_().filter(function (j) { return j.job_id === id; })[0];
  if (!job) throw new UserError('Job #' + id + ' not found');
  return job;
}

function isLive_(j) { return j.status === 'active' || j.status === 'paused'; }
