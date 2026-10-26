/**
 * ======================== THIN BOT API CLIENT ==========================
 * Never throws on HTTP errors: returns {ok:false, error_code, description, parameters}.
 */

function tgUrl_(method) { return 'https://api.telegram.org/bot' + getToken_() + '/' + method; }

function tgParams_(payload) {
  return {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  };
}

function tgParse_(res) {
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, error_code: res.getResponseCode(), description: 'Bad response: ' + res.getContentText().slice(0, 200) };
  }
}

function tg_(method, payload) {
  try {
    return tgParse_(UrlFetchApp.fetch(tgUrl_(method), tgParams_(payload)));
  } catch (e) {
    return { ok: false, error_code: 0, description: 'Network: ' + e.message };
  }
}

/** Like tg_, but throws an Error on ok:false. Used by setup functions. */
function tgCall_(method, payload) {
  const r = tg_(method, payload);
  if (!r.ok) {
    const err = new Error(method + ': ' + (r.description || 'Telegram error'));
    err.tg = r;
    throw err;
  }
  return r.result;
}

/** Sends ONE batch of requests in parallel. calls: [{method, payload}] */
function tgBatch_(calls) {
  if (!calls.length) return [];
  const reqs = calls.map(function (c) {
    const p = tgParams_(c.payload);
    p.url = tgUrl_(c.method);
    return p;
  });
  try {
    return UrlFetchApp.fetchAll(reqs).map(tgParse_);
  } catch (e) {
    // fetchAll fails as a whole on a network error — fall back to sequential requests
    return calls.map(function (c) { return tg_(c.method, c.payload); });
  }
}

/** Many requests: batches of CFG.SEND_BATCH with a pause (Telegram limit ~30 req/s). */
function tgBatchChunked_(calls) {
  let out = [];
  for (let i = 0; i < calls.length; i += CFG.SEND_BATCH) {
    if (i) Utilities.sleep(CFG.BATCH_PAUSE_MS);
    out = out.concat(tgBatch_(calls.slice(i, i + CFG.SEND_BATCH)));
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
function reply_(chatId, html) {
  splitMessage_(html).forEach(function (p) {
    const r = tg_('sendMessage', { chat_id: chatId, text: p, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (!r.ok && r.error_code === 400) tg_('sendMessage', { chat_id: chatId, text: p.replace(/<[^>]+>/g, '') }); // broken markup → resend as plain text
  });
}

function notifyAdmins_(html) {
  getAdminIds_().forEach(function (id) {
    try { reply_(id, html); } catch (e) { console.error('notify ' + id + ': ' + e.message); }
  });
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
 * Two rounds of parallel requests (getChat, then getChatMember) instead of 2×N sequential ones:
 * 50 chats are checked in ~2-3 s instead of ~40 s (important — a webhook must answer within a minute).
 * Returns an array of {ok, chat, problems[], warnings[]} in the order of refs.
 */
function checkChatsAccess_(refs) {
  const results = refs.map(function () { return { ok: false, chat: null, problems: [], warnings: [] }; });
  const chatResps = tgBatchChunked_(refs.map(function (ref) { return { method: 'getChat', payload: { chat_id: ref } }; }));

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

  const memberResps = tgBatchChunked_(pending.map(function (i) {
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

function checkChatAccess_(ref) { return checkChatsAccess_([ref])[0]; }

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
