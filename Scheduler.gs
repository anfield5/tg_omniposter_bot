/**
 * ============================== SCHEDULER ==============================
 * tick() is called by a time-driven trigger every minute.
 * To save the daily Apps Script quota, the next due time is cached in the NEXT_DUE
 * property: until it arrives, tick() exits within milliseconds without opening the spreadsheet.
 */

const NO_JOBS = 8.64e15; // "never"

function tick() {
  const p = props_().getProperties(); // one properties read instead of several
  if (p.MODE === 'polling') {
    try { pollUpdates_(); } catch (e) { console.error('poll: ' + e.stack); }
  }
  const nextDue = Number(p.NEXT_DUE || 0);
  if (nextDue && nextDue > Date.now() + CFG.EARLY_TOLERANCE_MS) return;
  runScheduler_();
}

/** Reset the cached next due time (after any change to Jobs). */
function invalidateSchedule_() { setProp_('NEXT_DUE', 0); }

function isDue_(j, now) {
  return j.status === 'active' && !!j.next_run_ms && j.next_run_ms <= now + CFG.EARLY_TOLERANCE_MS;
}

function runScheduler_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // another run is in progress — try again in a minute
  try {
    const started = Date.now();
    const jobs = readJobs_();
    const due = jobs.filter(function (j) { return isDue_(j, started); });
    const ctx = due.length ? buildChatCtx_() : null;

    for (let i = 0; i < due.length; i++) {
      if (Date.now() - started > CFG.TICK_BUDGET_MS) break; // the rest goes to the next tick
      const job = due[i];
      try {
        runJob_(job, ctx, jobs);
      } catch (e) {
        console.error('job #' + job.job_id + ': ' + e.stack);
        job.last_error = 'Error: ' + e.message;
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

/** Chat index: by list and by ID (for titles/usernames in the log). */
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

function runJob_(job, ctx, allJobs) {
  const now = Date.now();
  const runNo = job.runs + 1;
  const chatIds = resolveRecipients_(job, ctx);

  if (chatIds === null) {
    job.status = 'stopped';
    job.last_error = 'list deleted';
    saveJob_(job);
    notifyAdmins_('⏹ Job #' + job.job_id + ' stopped: list "' + esc_(job.target) + '" no longer exists');
    return;
  }

  // Advance the schedule BEFORE sending (at-most-once): if the script dies mid-run,
  // the next tick won't duplicate the post in every chat.
  job.next_run_ms = computeNextRun_(job.next_run_ms, job.interval_min, job.end_ms, now);
  if (!job.next_run_ms) job.status = 'done';
  job.runs = runNo;
  job.last_run = new Date(now);

  if (!chatIds.length) {
    job.last_error = 'list is empty';
    saveJob_(job);
    return;
  }
  saveJob_(job);

  const results = sendToChats_(job, chatIds, function (oldId, newId) {
    // group → supergroup: fix the sheet and this tick's in-memory jobs, otherwise they'd overwrite the new ID
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
    notifyAdmins_('⚠️ Job #' + job.job_id + ': not delivered to ' + failed.length + ' of ' + (failed.length + delivered) + ' chats\n' +
      failed.map(function (f) {
        const t = (ctx.byId[String(f.chatId)] || {}).title;
        return '• ' + (t ? esc_(t) + ' ' : '') + '<code>' + f.chatId + '</code> — ' + esc_(f.error);
      }).join('\n') + '\n\nCheck permissions: /checkchats');
  }
  job.last_error = summary;
  saveJob_(job);

  if (job.status === 'done') {
    notifyAdmins_('✅ Job #' + job.job_id + ' finished. Posts: ' + job.runs +
      (job.runs === 1 ? ', delivered ' + delivered + ' of ' + (failed.length + delivered) : ''));
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
  pending.forEach(function (id) { out.push({ chatId: id, ok: false, error: 'not sent after retries' }); });
  return out;
}
