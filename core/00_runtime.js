/**
 * ============================ CORE RUNTIME ============================
 * Shared by both backends: Google Apps Script (apps-script/) and the Node server (server/).
 *
 * Core files are plain scripts (no import/export): in Apps Script they become global
 * functions, on the server they are loaded with vm.runInThisContext.
 *
 * Everything platform-specific goes through the global PLATFORM object (storage, properties,
 * lock, time zone, secrets) or through EFFECTS. Functions that talk to Telegram or to the
 * control sheet are generators: they `yield` an effect and receive its result. Apps Script runs
 * them with a synchronous driver (UrlFetchApp), the server with an async driver (fetch).
 */

const VERSION = '2.0.0';
const RELEASE_DATE = '2026-11-24';

const CFG = {
  DATE_FMT: 'dd.MM.yyyy HH:mm',
  EARLY_TOLERANCE_MS: 30 * 1000,   // a post may go out ≤30 s early (GAS trigger fires at a random second)
  MIN_INTERVAL_MIN: 5,             // minimum repeat interval — protects against spam and Telegram limits
  SEND_BATCH: 20,                  // messages sent in parallel per batch
  BATCH_PAUSE_MS: 1100,            // pause between batches (Telegram limit ~30 msg/s)
  MAX_RETRY_AFTER_S: 30,           // don't wait longer on 429 — retry on the next run instead
  TICK_BUDGET_MS: 4.5 * 60 * 1000, // GAS execution limit is 6 min, keep a safety margin
  PREVIEW_LEN: 60,
  ALLOWED_UPDATES: ['message', 'my_chat_member'],
  // Backend switching (see core/control.js)
  HEARTBEAT_MS: 15 * 1000,         // server writes a heartbeat to the Control sheet this often
  SERVER_ALIVE_MS: 90 * 1000,      // /switch server is allowed only if the heartbeat is fresher than this
  LEASE_MS: 3 * 60 * 1000,         // an active server stops itself if it can't reach the sheet this long
  FAILOVER_MS: 5 * 60 * 1000,      // Apps Script takes over if an active server is silent this long
};

/**
 * Data schema shared by both backends. Column order = sheet column order.
 * Types: str | num | time (epoch ms in core; a date cell in Sheets).
 * New columns are only ever appended at the end, so existing sheets stay compatible.
 */
const SCHEMA = {
  lists: { sheet: 'Lists', key: 'list_name', cols: { list_name: 'str', created_at: 'time' } },
  chats: {
    sheet: 'Chats', key: 'chat_id',
    cols: { list_name: 'str', chat_id: 'str', title: 'str', type: 'str', username: 'str', added_at: 'time' },
  },
  jobs: {
    sheet: 'Jobs', key: 'job_id',
    cols: {
      job_id: 'num', status: 'str', kind: 'str', target_type: 'str', target: 'str', target_title: 'str',
      preview: 'str', payload: 'str', src_chat_id: 'str', src_msg_id: 'str', start: 'time', interval_min: 'num',
      end: 'time', mix_count: 'num', next_run: 'time', runs: 'num', last_run: 'time', last_error: 'str',
      created_at: 'time', created_by: 'str',
    },
  },
  log: {
    sheet: 'Log', key: 'time',
    cols: {
      time: 'time', job_id: 'num', run: 'num', target: 'str', chat_id: 'str', chat_title: 'str',
      message_id: 'num', link: 'str', status: 'str', error: 'str', backend: 'str',
    },
  },
};

/** Control sheet: fixed key layout (row 2..N, column B) so both backends can address cells directly. */
const CONTROL_SHEET = 'Control';
const CONTROL_KEYS = ['active_backend', 'epoch', 'server_heartbeat', 'server_version', 'switched_at', 'switched_by', 'gas_webhook_url'];

const BACKEND_NAMES = { gas: 'Apps Script', server: 'Server' };

/** An error whose (HTML) message is safe to show to the user. */
class UserError extends Error {}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lc_(s) { return String(s).trim().toLowerCase(); }

// ------------------------------ Platform glue ------------------------------

function tz_() { return PLATFORM.tzName(); }
function fmtDate_(ms) { return PLATFORM.tzFormat(ms, CFG.DATE_FMT); }

function getProp_(k) { return PLATFORM.getProp(k); }
function setProp_(k, v) { PLATFORM.setProp(k, String(v)); }

function getToken_() {
  const t = PLATFORM.secret('BOT_TOKEN');
  if (!t) throw new Error('BOT_TOKEN is not set');
  return String(t).trim();
}

/** Bot ID is the numeric part of the token before the colon — no getMe call needed. */
function getBotId_() { return Number(getToken_().split(':')[0]); }

function getAdminIds_() { return String(PLATFORM.secret('ADMIN_IDS') || '').split(/[\s,;]+/).filter(Boolean); }
function isAdmin_(id) { return getAdminIds_().indexOf(String(id)) !== -1; }

function fmtInterval_(min) {
  min = Number(min);
  if (min % 1440 === 0) return (min / 1440) + 'd';
  if (min % 60 === 0) return (min / 60) + 'h';
  if (min > 60) return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  return min + 'm';
}

function fmtAgo_(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return s + ' s ago';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  return fmtDate_(ms);
}

// --------------------------------- Effects ---------------------------------
// Each effect is executed by the platform driver (apps-script/Platform.gs, server/src/driver.js).

/** One Bot API call → {ok, result | error_code, description, parameters}. Never throws. */
function* tgE_(method, payload) { return yield { t: 'tg', method: method, payload: payload || {} }; }
/** Parallel Bot API calls (one batch) → array of responses. */
function* tgBatchE_(calls) { return calls.length ? yield { t: 'batch', calls: calls } : []; }
function* sleepE_(ms) { yield { t: 'sleep', ms: ms }; }
/** Durability point: the server flushes its SQLite changes to the sheet here (no-op in Apps Script). */
function* checkpointE_() { yield { t: 'checkpoint' }; }
/** Reads the Control sheet → {active_backend, epoch, server_heartbeat, ...}. */
function* getControlE_() { return yield { t: 'getControl' }; }
/** Hands Telegram ingress + scheduling over to another backend. Returns a status string. */
function* handoverE_(to, by) { return yield { t: 'handover', to: to, by: by }; }
