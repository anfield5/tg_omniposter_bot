/**
 * ============================== SCHEDULER ==============================
 * The platform calls runSchedulerE_() periodically (Apps Script: every minute; server: every few seconds).
 * The next due time is cached in the NEXT_DUE property, so idle runs exit without reading the jobs table.
 */

const NO_JOBS = 8.64e15; // "never"

/** Reset the cached next due time (after any change to Jobs or after a backend switch). */
function invalidateSchedule_() { setProp_('NEXT_DUE', 0); }

/** How early a post may go out: Apps Script ticks once a minute, the server every few seconds (0). */
function earlyMs_() { return PLATFORM.earlyToleranceMs != null ? PLATFORM.earlyToleranceMs : CFG.EARLY_TOLERANCE_MS; }

/** Cheap check: is anything possibly due? */
function schedulerMaybeDue_() {
  const nextDue = Number(getProp_('NEXT_DUE') || 0);
  return !nextDue || nextDue <= Date.now() + earlyMs_();
}

function isDue_(j, now) {
  return j.status === 'active' && !!j.next_run && j.next_run <= now + earlyMs_();
}

function* runSchedulerE_() {
  if (!schedulerMaybeDue_()) return;
  if (!PLATFORM.lock(10000)) return; // another run is in progress — try again later
  try {
    const started = Date.now();
    const jobs = readJobs_();
    const due = jobs.filter(function (j) { return isDue_(j, started); });
    const ctx = due.length ? buildChatCtx_() : null;

    for (let i = 0; i < due.length; i++) {
      if (Date.now() - started > CFG.TICK_BUDGET_MS) break; // the rest goes to the next run
      const job = due[i];
      try {
        yield* runJobE_(job, ctx, jobs);
      } catch (e) {
        PLATFORM.log('error', 'job #' + job.job_id + ': ' + (e && e.stack));
        job.last_error = 'Error: ' + e.message;
        saveJob_(job);
      }
    }

    let min = NO_JOBS;
    jobs.forEach(function (j) {
      if (j.status === 'active' && j.next_run && j.next_run < min) min = j.next_run;
    });
    setProp_('NEXT_DUE', min);
  } finally {
    PLATFORM.unlock();
  }
}

/** Chat index: by list and by ID (for titles/usernames in the log). */
function buildChatCtx_() {
  const byList = {}, byId = {}, lists = {};
  rows_('lists').forEach(function (l) { lists[lc_(l.list_name)] = true; });
  rows_('chats').forEach(function (c) {
    const k = lc_(c.list_name);
    (byList[k] = byList[k] || []).push(c);
    byId[String(c.chat_id)] = c;
  });
  return { byList: byList, byId: byId, lists: lists };
}

/** Post recipients; null means the list was deleted. */
function resolveRecipients_(job, ctx) {
  if (job.target_type !== 'list') return [job.target];
  const key = lc_(job.target);
  if (!ctx.lists[key]) return null;
  const uniq = {};
  (ctx.byList[key] || []).forEach(function (c) { uniq[String(c.chat_id)] = true; });
  const ids = Object.keys(uniq);
  // -mix: the first post goes to all chats, then to N random ones
  return job.mix_count && job.runs > 0 ? sample_(ids, job.mix_count) : ids;
}

function* runJobE_(job, ctx, allJobs) {
  const now = Date.now();
  const runNo = job.runs + 1;
  const chatIds = resolveRecipients_(job, ctx);

  if (chatIds === null) {
    job.status = 'stopped';
    job.last_error = 'list deleted';
    saveJob_(job);
    yield* notifyAdminsE_('⏹ Job #' + job.job_id + ' stopped: list "' + esc_(job.target) + '" no longer exists');
    return;
  }

  // Advance the schedule BEFORE sending (at-most-once): if the process dies mid-run,
  // nobody re-sends this slot — neither this backend nor the other one after a failover.
  job.next_run = computeNextRun_(job.next_run, job.interval_min, job.end, now);
  if (!job.next_run) job.status = 'done';
  job.runs = runNo;
  job.last_run = now;

  if (!chatIds.length) {
    job.last_error = 'list is empty';
    saveJob_(job);
    return;
  }
  saveJob_(job);
  yield* checkpointE_(); // server: persist the advanced schedule to the sheet before sending

  const results = yield* sendToChatsE_(job, chatIds, function (oldId, newId) {
    // group → supergroup: fix storage and this run's in-memory jobs, otherwise they'd overwrite the new ID
    migrateChatId_(oldId, newId);
    allJobs.forEach(function (j) { if (j.target_type === 'chat' && j.target === String(oldId)) j.target = String(newId); });
    if (ctx.byId[oldId]) ctx.byId[newId] = ctx.byId[oldId];
  });

  writeLog_(job, runNo, results, ctx);

  // Errors — notify only when the set of errors changes (no spam on every run)
  const failed = results.filter(function (r) { return !r.ok && !r.migratedTo; });
  const delivered = results.filter(function (r) { return r.ok; }).length;
  const summary = failed.map(function (f) { return f.chatId + ': ' + f.error; }).join('; ').slice(0, 500);
  if (summary && summary !== String(job.last_error || '')) {
    yield* notifyAdminsE_('⚠️ Job #' + job.job_id + ': not delivered to ' + failed.length + ' of ' + (failed.length + delivered) + ' chats\n' +
      failed.map(function (f) {
        const t = (ctx.byId[String(f.chatId)] || {}).title;
        return '• ' + (t ? esc_(t) + ' ' : '') + '<code>' + f.chatId + '</code> — ' + esc_(f.error);
      }).join('\n') + '\n\nCheck permissions: /checkchats');
  }
  job.last_error = summary;
  saveJob_(job);

  if (job.status === 'done') {
    yield* notifyAdminsE_('✅ Job #' + job.job_id + ' finished. Posts: ' + job.runs +
      (job.runs === 1 ? ', delivered ' + delivered + ' of ' + (failed.length + delivered) : ''));
  }
}

function writeLog_(job, runNo, results, ctx) {
  const at = Date.now();
  insert_('log', results.map(function (r) {
    const info = ctx.byId[String(r.chatId)] || {};
    return {
      time: at, job_id: job.job_id, run: runNo, backend: PLATFORM.name,
      target: job.target_type + ':' + job.target,
      chat_id: String(r.chatId),
      chat_title: info.title || (job.target_type === 'chat' ? job.target_title : '') || '',
      message_id: r.messageId || null,
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
  // copy / copy_caption — a copy of a message from the admin's private chat (photo, video, documents, any formatting)
  const payload = { chat_id: chatId, from_chat_id: job.src_chat_id, message_id: Number(job.src_msg_id) };
  if (job.kind === 'copy_caption') {
    payload.caption = p.text || '';
    if (p.entities && p.entities.length) payload.caption_entities = p.entities;
  }
  return { method: 'copyMessage', payload: payload };
}

/**
 * Sends to all chats in parallel batches, handling:
 *   429 Too Many Requests → wait retry_after and retry;
 *   migrate_to_chat_id    → group became a supergroup: onMigrate(old, new) and retry with the new ID.
 * Returns [{chatId, ok, messageId, error, migratedTo}]
 */
function* sendToChatsE_(job, chatIds, onMigrate) {
  const out = [];
  let pending = chatIds.slice();
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    const retry = [];
    let wait = 0;
    const resps = yield* tgBatchChunkedE_(pending.map(function (id) { return buildSendCall_(job, id); }));
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
    if (retry.length && wait) yield* sleepE_(wait * 1000);
    pending = retry;
  }
  pending.forEach(function (id) { out.push({ chatId: id, ok: false, error: 'not sent after retries' }); });
  return out;
}
