/**
 * ======================= ТОЧКИ ВХОДА И УСТАНОВКА =======================
 *
 * Запускать вручную из редактора (выбрать функцию → Run):
 *   1. setup()        — создать листы, проверить токен, зарегистрировать меню команд
 *   2. (Deploy → New deployment → Web app: Execute as Me, Who has access: Anyone)
 *   3. setWebhook()   — подключить вебхук и триггер планировщика
 *   Альтернатива п.3: usePolling() — без веб-приложения, команды обрабатываются раз в минуту
 *   webhookInfo()     — диагностика
 */

// ---------------------------- Webhook ----------------------------

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ok_();
    const secret = prop_('WEBHOOK_SECRET');
    // Apps Script не даёт читать заголовки, поэтому секрет передаётся в query-параметре URL
    if (secret && (e.parameter || {}).secret !== secret) return ok_();

    const update = JSON.parse(e.postData.contents);
    // Дедупликация: Telegram повторяет апдейт, если ответ был неуспешным/медленным
    const cache = CacheService.getScriptCache();
    const key = 'upd_' + update.update_id;
    if (cache.get(key)) return ok_();
    cache.put(key, '1', 21600);

    handleUpdate_(update);
  } catch (err) {
    console.error('doPost: ' + (err && err.stack));
  }
  return ok_(); // всегда 200, иначе Telegram будет бесконечно повторять апдейт
}

function doGet() { return ok_(); }

/** HtmlService отвечает 200 напрямую (ContentService отдаёт 302-редирект, который Telegram считает ошибкой). */
function ok_() { return HtmlService.createHtmlOutput('ok'); }

// ---------------------------- Polling ----------------------------

function pollUpdates_() {
  const offset = Number(prop_('POLL_OFFSET') || 0);
  const r = tg_('getUpdates', { offset: offset || undefined, timeout: 0, limit: 50, allowed_updates: CFG.ALLOWED_UPDATES });
  if (!r.ok) { console.warn('getUpdates: ' + r.description); return; }
  r.result.forEach(function (u) {
    setProp_('POLL_OFFSET', u.update_id + 1); // сначала подтверждаем, потом обрабатываем (без повторов)
    try { handleUpdate_(u); } catch (e) { console.error(e.stack); }
  });
}

// ----------------------------- Setup -----------------------------

const BOT_COMMANDS = [
  { command: 'post', description: 'Запланировать пост' },
  { command: 'jobs', description: 'Активные задачи' },
  { command: 'lists', description: 'Все списки' },
  { command: 'showlist', description: 'Чаты в списке' },
  { command: 'addlist', description: 'Создать список' },
  { command: 'removelist', description: 'Удалить список' },
  { command: 'addchat', description: 'Добавить чат в список' },
  { command: 'removechat', description: 'Удалить чат из списка/всех списков' },
  { command: 'checkchats', description: 'Проверить права бота' },
  { command: 'pausejob', description: 'Пауза задачи' },
  { command: 'resumejob', description: 'Возобновить задачу' },
  { command: 'stopjob', description: 'Остановить задачу' },
  { command: 'version', description: 'Версия бота' },
  { command: 'help', description: 'Справка' },
];

function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(tz_()); // даты в листах = часовой пояс скрипта
  Object.keys(SHEET_DEFS).forEach(sheet_);
  ['Sheet1', 'Лист1', 'Аркуш1'].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  const me = tgCall_('getMe');
  if (!getAdminIds_().length) throw new Error('Заполните ADMIN_IDS (свой Telegram ID можно узнать, написав боту /start)');
  tgCall_('setMyCommands', { commands: BOT_COMMANDS, scope: { type: 'all_private_chats' } });
  console.log('OK: бот @' + me.username + ', часовой пояс ' + tz_() + ', админы: ' + getAdminIds_().join(', '));
}

function setWebhook() {
  const url = prop_('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url || !/\/exec$/.test(url)) {
    throw new Error('Не найден URL веб-приложения. Сделайте Deploy → Web app и укажите WEBAPP_URL (…/exec) в Script Properties');
  }
  let secret = prop_('WEBHOOK_SECRET');
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, ''); setProp_('WEBHOOK_SECRET', secret); }
  tgCall_('setWebhook', {
    url: url + '?secret=' + secret,
    allowed_updates: CFG.ALLOWED_UPDATES,
    max_connections: 1,          // обрабатываем апдейты по одному — проще с блокировками GAS
    drop_pending_updates: true,
  });
  setProp_('MODE', 'webhook');
  installTriggers();
  console.log('Webhook установлен: ' + url);
}

function usePolling() {
  tgCall_('deleteWebhook', { drop_pending_updates: false });
  setProp_('MODE', 'polling');
  installTriggers();
  console.log('Режим polling: команды обрабатываются раз в ' + CFG.TICK_MINUTES + ' мин');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(CFG.TICK_MINUTES).create();
  invalidateSchedule_();
}

function webhookInfo() {
  const info = tgCall_('getWebhookInfo');
  if (info.url) info.url = info.url.replace(/secret=\w+/, 'secret=***');
  console.log(JSON.stringify(info, null, 2) + '\nMODE=' + prop_('MODE') + ', NEXT_DUE=' + prop_('NEXT_DUE'));
}
