/**
 * ============================ КОНФИГУРАЦИЯ ============================
 *
 * Секреты хранятся НЕ в коде, а в Script Properties
 * (Project Settings → Script properties):
 *
 *   BOT_TOKEN   — токен бота от @BotFather                    (обязательно)
 *   ADMIN_IDS   — Telegram user ID админов через запятую      (обязательно)
 *   WEBAPP_URL  — URL веб-приложения вида https://script.google.com/macros/s/…/exec
 *                 (нужен, если ScriptApp не отдаёт URL сам)
 *
 * Заполняются автоматически: WEBHOOK_SECRET, MODE, JOB_SEQ, NEXT_DUE, POLL_OFFSET.
 */

const VERSION = '1.0.0';
const RELEASE_DATE = '2026-10-26';

const CFG = {
  DATE_FMT: 'dd.MM.yyyy HH:mm',
  TICK_MINUTES: 1,                 // как часто срабатывает планировщик (1, 5, 10, 15, 30)
  EARLY_TOLERANCE_MS: 30 * 1000,   // пост может уйти на ≤30 c раньше (триггер срабатывает в случайную секунду)
  MIN_INTERVAL_MIN: 5,             // минимальная регулярность — защита от спама и лимитов Telegram
  SEND_BATCH: 20,                  // сколько сообщений отправлять параллельно (UrlFetchApp.fetchAll)
  BATCH_PAUSE_MS: 1100,            // пауза между пачками (лимит Telegram ~30 msg/s)
  MAX_RETRY_AFTER_S: 30,           // дольше ждать при 429 не будем — повторим в следующий раз
  TICK_BUDGET_MS: 4.5 * 60 * 1000, // лимит выполнения GAS — 6 мин, оставляем запас
  PREVIEW_LEN: 60,
  ALLOWED_UPDATES: ['message', 'my_chat_member'],
};

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }
function setProp_(k, v) { props_().setProperty(k, String(v)); }
function tz_() { return Session.getScriptTimeZone(); }

function getToken_() {
  const t = prop_('BOT_TOKEN');
  if (!t) throw new Error('Не задан BOT_TOKEN в Script Properties');
  return t.trim();
}

/** ID бота — числовая часть токена до двоеточия, лишний getMe не нужен. */
function getBotId_() { return Number(getToken_().split(':')[0]); }

function getAdminIds_() {
  return (prop_('ADMIN_IDS') || '').split(/[\s,;]+/).filter(Boolean);
}
function isAdmin_(id) { return getAdminIds_().indexOf(String(id)) !== -1; }

function fmtDate_(ms) { return Utilities.formatDate(new Date(ms), tz_(), CFG.DATE_FMT); }

function fmtInterval_(min) {
  min = Number(min);
  if (min % 1440 === 0) return (min / 1440) + ' д';
  if (min % 60 === 0) return (min / 60) + ' ч';
  if (min > 60) return Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин';
  return min + ' мин';
}

/** Ошибка, текст которой (HTML) можно показать пользователю. */
class UserError extends Error {}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
