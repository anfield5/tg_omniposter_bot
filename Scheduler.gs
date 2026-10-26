/**
 * ============================ ПЛАНИРОВЩИК ============================
 * tick() вызывается time-driven триггером каждую минуту.
 * Чтобы не тратить дневную квоту Apps Script, время ближайшего запуска кэшируется
 * в свойстве NEXT_DUE: пока оно не наступило, tick() завершается за миллисекунды,
 * не открывая таблицу.
 */

const NO_JOBS = 8.64e15; // «никогда»

function tick() {
  const p = props_().getProperties(); // одно чтение свойств вместо нескольких
  if (p.MODE === 'polling') {
    try { pollUpdates_(); } catch (e) { console.error('poll: ' + e.stack); }
  }
  const nextDue = Number(p.NEXT_DUE || 0);
  if (nextDue && nextDue > Date.now() + CFG.EARLY_TOLERANCE_MS) return;
  runScheduler_();
}

/** Сбросить кэш ближайшего запуска (после любых изменений в Jobs). */
function invalidateSchedule_() { setProp_('NEXT_DUE', 0); }

function isDue_(j, now) {
  return j.status === 'active' && !!j.next_run_ms && j.next_run_ms <= now + CFG.EARLY_TOLERANCE_MS;
}

function runScheduler_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // идёт другая рассылка — попробуем через минуту
  try {
    const started = Date.now();
    const jobs = readJobs_();
    const due = jobs.filter(function (j) { return isDue_(j, started); });
    const ctx = due.length ? buildChatCtx_() : null;

    for (let i = 0; i < due.length; i++) {
      if (Date.now() - started > CFG.TICK_BUDGET_MS) break; // остальное — в следующий тик
      const job = due[i];
      try {
        runJob_(job, ctx, jobs);
      } catch (e) {
        console.error('job #' + job.job_id + ': ' + e.stack);
        job.last_error = 'Ошибка: ' + e.message;
        saveJob_(job);
      }
    }

    let min = NO_JOBS;
    jobs.forEach(function (j) {
      if (j.status === 'active' && j.next_run_ms && j.next_run_ms < min) min = j.next_run_ms;
    });
    setProp_('NEXT_DUE', min);
  } finally {
    lock.releaseLock();
  }
}

/** Индекс чатов: по спискам и по ID (для заголовков/username в журнале). */
function buildChatCtx_() {
  const byList = {}, byId = {}, lists = {};
  readAll_('lists').forEach(function (l) { lists[lc_(l.list_name)] = true; });
  readAll_('chats').forEach(function (c) {
    const k = lc_(c.list_name);
    (byList[k] = byList[k] || []).push(c);
    byId[String(c.chat_id)] = c;
  });
  return { byList: byList, byId: byId, lists: lists };
}

/** Получатели публикации; null — список удалён. */
function resolveRecipients_(job, ctx) {
  if (job.target_type !== 'list') return [job.target];
  const key = lc_(job.target);
  if (!ctx.lists[key]) return null;
  const uniq = {};
  (ctx.byList[key] || []).forEach(function (c) { uniq[String(c.chat_id)] = true; });
  const ids = Object.keys(uniq);
  // -mix: первая публикация — во все чаты, дальше — в N случайных
  return job.mix_count && job.runs > 0 ? sample_(ids, job.mix_count) : ids;
}

function runJob_(job, ctx, allJobs) {
  const now = Date.now();
  const runNo = job.runs + 1;
  const chatIds = resolveRecipients_(job, ctx);

  if (chatIds === null) {
    job.status = 'stopped';
    job.last_error = 'список удалён';
    saveJob_(job);
    notifyAdmins_('⏹ Задача #' + job.job_id + ' остановлена: списка «' + esc_(job.target) + '» больше нет');
    return;
  }

  // Сдвигаем расписание ДО отправки (at-most-once): если скрипт упадёт посреди
  // рассылки, следующий тик не продублирует пост во всех чатах.
  job.next_run_ms = computeNextRun_(job.next_run_ms, job.interval_min, job.end_ms, now);
  if (!job.next_run_ms) job.status = 'done';
  job.runs = runNo;
  job.last_run = new Date(now);

  if (!chatIds.length) {
    job.last_error = 'список пуст';
    saveJob_(job);
    return;
  }
  saveJob_(job);

  const results = sendToChats_(job, chatIds, function (oldId, newId) {
    // группа → супергруппа: правим таблицу и in-memory задачи этого тика, иначе они затрут новый ID
    migrateChatId_(oldId, newId);
    allJobs.forEach(function (j) { if (j.target_type === 'chat' && j.target === String(oldId)) j.target = String(newId); });
    if (ctx.byId[oldId]) ctx.byId[newId] = ctx.byId[oldId];
  });

  writeLog_(job, runNo, results, ctx);

  // Ошибки — уведомляем, только если набор ошибок изменился (без спама каждый запуск)
  const failed = results.filter(function (r) { return !r.ok && !r.migratedTo; });
  const delivered = results.filter(function (r) { return r.ok; }).length;
  const summary = failed.map(function (f) { return f.chatId + ': ' + f.error; }).join('; ').slice(0, 500);
  if (summary && summary !== String(job.last_error || '')) {
    notifyAdmins_('⚠️ Задача #' + job.job_id + ': не доставлено в ' + failed.length + ' из ' + (failed.length + delivered) + ' чатов\n' +
      failed.map(function (f) {
        const t = (ctx.byId[String(f.chatId)] || {}).title;
        return '• ' + (t ? esc_(t) + ' ' : '') + '<code>' + f.chatId + '</code> — ' + esc_(f.error);
      }).join('\n') + '\n\nПроверьте права: /checkchats');
  }
  job.last_error = summary;
  saveJob_(job);

  if (job.status === 'done') {
    notifyAdmins_('✅ Задача #' + job.job_id + ' завершена. Публикаций: ' + job.runs +
      (job.runs === 1 ? ', доставлено ' + delivered + ' из ' + (failed.length + delivered) : ''));
  }
}

function writeLog_(job, runNo, results, ctx) {
  const at = new Date();
  appendRows_('log', results.map(function (r) {
    const info = ctx.byId[String(r.chatId)] || {};
    return {
      time: at, job_id: job.job_id, run: runNo,
      target: job.target_type + ':' + job.target,
      chat_id: String(r.chatId),
      chat_title: info.title || (job.target_type === 'chat' ? job.target_title : '') || '',
      message_id: r.messageId || '',
      link: r.ok ? messageLink_(r.chatId, info.username, r.messageId) : '',
      status: r.ok ? 'ok' : (r.migratedTo ? 'migrated' : 'error'),
      error: r.error || '',
    };
  }));
}

function buildSendCall_(job, chatId) {
  const p = job.payloadObj || {};
  if (job.kind === 'text') {
    const payload = { chat_id: chatId, text: p.text };
    if (p.entities && p.entities.length) payload.entities = p.entities;
    return { method: 'sendMessage', payload: payload };
  }
  // copy / copy_caption — копия сообщения из лички админа (фото, видео, документы, любое форматирование)
  const payload = { chat_id: chatId, from_chat_id: job.src_chat_id, message_id: Number(job.src_msg_id) };
  if (job.kind === 'copy_caption') {
    payload.caption = p.text || '';
    if (p.entities && p.entities.length) payload.caption_entities = p.entities;
  }
  return { method: 'copyMessage', payload: payload };
}

/**
 * Отправка во все чаты параллельными пачками с обработкой:
 *   429 Too Many Requests → ждём retry_after и повторяем;
 *   migrate_to_chat_id    → группа стала супергруппой: onMigrate(old, new) и повтор на новый ID.
 * Возвращает [{chatId, ok, messageId, error, migratedTo}]
 */
function sendToChats_(job, chatIds, onMigrate) {
  const out = [];
  let pending = chatIds.slice();
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    const retry = [];
    let wait = 0;
    const resps = tgBatchChunked_(pending.map(function (id) { return buildSendCall_(job, id); }));
    resps.forEach(function (r, k) {
      const id = pending[k];
      const params = r.parameters || {};
      if (r.ok) {
        out.push({ chatId: id, ok: true, messageId: r.result && r.result.message_id });
      } else if (params.migrate_to_chat_id) {
        const nid = String(params.migrate_to_chat_id);
        onMigrate(id, nid);
        out.push({ chatId: id, ok: false, migratedTo: nid, error: 'migrated → ' + nid });
        retry.push(nid);
      } else if (r.error_code === 429 && attempt < 2 && (params.retry_after || 1) <= CFG.MAX_RETRY_AFTER_S) {
        wait = Math.max(wait, params.retry_after || 1);
        retry.push(id);
      } else {
        out.push({ chatId: id, ok: false, error: (r.error_code ? r.error_code + ' ' : '') + (r.description || 'unknown error') });
      }
    });
    if (retry.length && wait) Utilities.sleep(wait * 1000);
    pending = retry;
  }
  pending.forEach(function (id) { out.push({ chatId: id, ok: false, error: 'не отправлено после повторов' }); });
  return out;
}
