/**
 * ========================== TELEGRAM (via effects) ==========================
 * All calls go through tgE_/tgBatchE_ effects, so the same code runs in Apps Script and on the server.
 */

/** Like tgE_, but throws an Error on ok:false. */
function* tgCallE_(method, payload) {
  const r = yield* tgE_(method, payload);
  if (!r.ok) {
    const err = new Error(method + ': ' + (r.description || 'Telegram error'));
    err.tg = r;
    throw err;
  }
  return r.result;
}

/** Many requests: batches of CFG.SEND_BATCH with a pause (Telegram limit ~30 req/s). */
function* tgBatchChunkedE_(calls) {
  let out = [];
  for (let i = 0; i < calls.length; i += CFG.SEND_BATCH) {
    if (i) yield* sleepE_(CFG.BATCH_PAUSE_MS);
    out = out.concat(yield* tgBatchE_(calls.slice(i, i + CFG.SEND_BATCH)));
  }
  return out;
}

/** Splits text into parts ≤4000 chars: by lines (so HTML tags aren't broken), over-long lines are hard-cut. */
function splitMessage_(html) {
  const LIMIT = 4000;
  const parts = [];
  let cur = '';
  String(html).split('\n').forEach(function (line) {
    while (line.length > LIMIT) {
      if (cur) { parts.push(cur); cur = ''; }
      parts.push(line.slice(0, LIMIT));
      line = line.slice(LIMIT);
    }
    if (cur && (cur.length + 1 + line.length) > LIMIT) { parts.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  });
  if (cur) parts.push(cur);
  return parts;
}

/** Reply in private chat (HTML). */
function* replyE_(chatId, html) {
  const parts = splitMessage_(html);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const r = yield* tgE_('sendMessage', { chat_id: chatId, text: p, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (!r.ok && r.error_code === 400) yield* tgE_('sendMessage', { chat_id: chatId, text: p.replace(/<[^>]+>/g, '') }); // broken markup → plain text
  }
}

function* notifyAdminsE_(html) {
  const ids = getAdminIds_();
  for (let i = 0; i < ids.length; i++) yield* replyE_(ids[i], html);
}

/** Link to a message (works for channels/supergroups). */
function messageLink_(chatId, username, messageId) {
  if (!messageId) return '';
  if (username) return 'https://t.me/' + username + '/' + messageId;
  const s = String(chatId);
  if (s.indexOf('-100') === 0) return 'https://t.me/c/' + s.slice(4) + '/' + messageId;
  return '';
}

function chatTypeName_(t) {
  return { channel: 'channel', supergroup: 'supergroup', group: 'group' }[t] || t;
}

// ---------------------------- Permission check ----------------------------

/**
 * Batch check: can the bot post to these chats?
 * Two rounds of parallel requests (getChat, then getChatMember) instead of 2×N sequential ones.
 * Returns an array of {ok, chat, problems[], warnings[]} in the order of refs.
 */
function* checkChatsAccessE_(refs) {
  const results = refs.map(function () { return { ok: false, chat: null, problems: [], warnings: [] }; });
  const chatResps = yield* tgBatchChunkedE_(refs.map(function (ref) { return { method: 'getChat', payload: { chat_id: ref } }; }));

  const botId = getBotId_();
  const pending = [];
  chatResps.forEach(function (gc, i) {
    const r = results[i];
    if (!gc.ok) {
      r.problems.push(gc.error_code === 400 || gc.error_code === 403
        ? 'the bot can\'t see this chat — it hasn\'t been added or the ID is wrong'
        : 'Telegram error: ' + esc_(gc.description));
      return;
    }
    r.chat = gc.result;
    if (r.chat.type === 'private') { r.problems.push('this is a private chat, not a group/channel'); return; }
    pending.push(i);
  });

  const memberResps = yield* tgBatchChunkedE_(pending.map(function (i) {
    return { method: 'getChatMember', payload: { chat_id: results[i].chat.id, user_id: botId } };
  }));
  memberResps.forEach(function (gm, k) {
    const r = results[pending[k]];
    if (!gm.ok) { r.problems.push('could not get the bot\'s permissions: ' + esc_(gm.description)); return; }
    evaluateRights_(r, r.chat, gm.result);
  });

  results.forEach(function (r) { r.ok = !!r.chat && r.problems.length === 0; });
  return results;
}

function* checkChatAccessE_(ref) { return (yield* checkChatsAccessE_([ref]))[0]; }

/** Pure permission logic (no requests) — also reused for my_chat_member notifications. */
function evaluateRights_(r, chat, m) {
  if (m.status === 'left') { r.problems.push('the bot is not a member of this chat'); return r; }
  if (m.status === 'kicked') { r.problems.push('the bot was removed/banned from this chat'); return r; }

  if (chat.type === 'channel') {
    if (m.status !== 'administrator') r.problems.push('in a channel the bot must be an <b>administrator</b>');
    else if (!m.can_post_messages) r.problems.push('the bot lacks the "Post messages" right');
    return r;
  }
  const isAdm = m.status === 'administrator' || m.status === 'creator';
  if (m.status === 'restricted' && !m.can_send_messages) {
    r.problems.push('the bot is not allowed to send messages in this group');
  } else if (m.status === 'member' && chat.permissions && chat.permissions.can_send_messages === false) {
    r.problems.push('members can\'t send messages in this group — make the bot an admin');
  }
  if (!isAdm && chat.slow_mode_delay) {
    r.warnings.push('slow mode is on (' + chat.slow_mode_delay + ' s) — it applies to a non-admin bot');
  }
  if (!isAdm && chat.permissions && chat.permissions.can_send_photos === false) {
    r.warnings.push('members can\'t send photos — media posts may fail');
  }
  return r;
}
