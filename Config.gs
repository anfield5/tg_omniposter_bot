/**
 * =========================== CONFIGURATION ===========================
 *
 * Secrets are NOT stored in code but in Script Properties
 * (Project Settings → Script properties):
 *
 *   BOT_TOKEN   — bot token from @BotFather                     (required)
 *   ADMIN_IDS   — comma-separated Telegram user IDs of admins   (required)
 *   WEBAPP_URL  — web app URL like https://script.google.com/macros/s/…/exec
 *                 (needed if ScriptApp can't resolve the URL itself)
 *
 * Filled in automatically: WEBHOOK_SECRET, MODE, JOB_SEQ, NEXT_DUE, POLL_OFFSET.
 */

const VERSION = '1.0.0';
const RELEASE_DATE = '2026-10-26';

const CFG = {
  DATE_FMT: 'dd.MM.yyyy HH:mm',
  TICK_MINUTES: 1,                 // scheduler trigger frequency (1, 5, 10, 15, 30)
  EARLY_TOLERANCE_MS: 30 * 1000,   // a post may go out ≤30 s early (the trigger fires at a random second)
  MIN_INTERVAL_MIN: 5,             // minimum repeat interval — protects against spam and Telegram limits
  SEND_BATCH: 20,                  // messages sent in parallel per batch (UrlFetchApp.fetchAll)
  BATCH_PAUSE_MS: 1100,            // pause between batches (Telegram limit ~30 msg/s)
  MAX_RETRY_AFTER_S: 30,           // don't wait longer on 429 — retry on the next run instead
  TICK_BUDGET_MS: 4.5 * 60 * 1000, // GAS execution limit is 6 min, keep a safety margin
  PREVIEW_LEN: 60,
  ALLOWED_UPDATES: ['message', 'my_chat_member'],
};

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }
function setProp_(k, v) { props_().setProperty(k, String(v)); }
function tz_() { return Session.getScriptTimeZone(); }

function getToken_() {
  const t = prop_('BOT_TOKEN');
  if (!t) throw new Error('BOT_TOKEN is not set in Script Properties');
  return t.trim();
}

/** Bot ID is the numeric part of the token before the colon — no getMe call needed. */
function getBotId_() { return Number(getToken_().split(':')[0]); }

function getAdminIds_() {
  return (prop_('ADMIN_IDS') || '').split(/[\s,;]+/).filter(Boolean);
}
function isAdmin_(id) { return getAdminIds_().indexOf(String(id)) !== -1; }

function fmtDate_(ms) { return Utilities.formatDate(new Date(ms), tz_(), CFG.DATE_FMT); }

function fmtInterval_(min) {
  min = Number(min);
  if (min % 1440 === 0) return (min / 1440) + 'd';
  if (min % 60 === 0) return (min / 60) + 'h';
  if (min > 60) return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  return min + 'm';
}

/** An error whose (HTML) message is safe to show to the user. */
class UserError extends Error {}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
