/**
 * ======================== ТОНКИЙ КЛИЕНТ BOT API ========================
 * Никогда не бросает исключения на HTTP-ошибках: возвращает {ok:false, error_code, description, parameters}.
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

/** Как tg_, но бросает Error при ok:false. Для setup-функций. */
function tgCall_(method, payload) {
  const r = tg_(method, payload);
  if (!r.ok) {
    const err = new Error(method + ': ' + (r.description || 'Telegram error'));
    err.tg = r;
    throw err;
  }
  return r.result;
}

/** Параллельная отправка ОДНОЙ пачки запросов. calls: [{method, payload}] */
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
    // fetchAll падает целиком при сетевой ошибке — откатываемся на последовательную отправку
    return calls.map(function (c) { return tg_(c.method, c.payload); });
  }
}

/** Много запросов: пачками по CFG.SEND_BATCH с паузой (лимит Telegram ~30 запросов/с). */
function tgBatchChunked_(calls) {
  let out = [];
  for (let i = 0; i < calls.length; i += CFG.SEND_BATCH) {
    if (i) Utilities.sleep(CFG.BATCH_PAUSE_MS);
    out = out.concat(tgBatch_(calls.slice(i, i + CFG.SEND_BATCH)));
  }
  return out;
}

/** Делит текст на части ≤4000 символов: по строкам (чтобы не рвать HTML-теги), слишком длинные строки — жёстко. */
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

/** Ответ в личку (HTML). */
function reply_(chatId, html) {
  splitMessage_(html).forEach(function (p) {
    const r = tg_('sendMessage', { chat_id: chatId, text: p, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (!r.ok && r.error_code === 400) tg_('sendMessage', { chat_id: chatId, text: p.replace(/<[^>]+>/g, '') }); // битая разметка → без неё
  });
}

function notifyAdmins_(html) {
  getAdminIds_().forEach(function (id) {
    try { reply_(id, html); } catch (e) { console.error('notify ' + id + ': ' + e.message); }
  });
}

/** Ссылка на сообщение (работает для каналов/супергрупп). */
function messageLink_(chatId, username, messageId) {
  if (!messageId) return '';
  if (username) return 'https://t.me/' + username + '/' + messageId;
  const s = String(chatId);
  if (s.indexOf('-100') === 0) return 'https://t.me/c/' + s.slice(4) + '/' + messageId;
  return '';
}

function chatTypeName_(t) {
  return { channel: 'канал', supergroup: 'супергруппа', group: 'группа' }[t] || t;
}

// ----------------------------- Проверка прав -----------------------------

/**
 * Пакетная проверка: может ли бот публиковать в чатах.
 * Два раунда параллельных запросов (getChat, затем getChatMember) вместо 2×N последовательных:
 * 50 чатов проверяются за ~2-3 с, а не за ~40 с (важно — вебхук не должен отвечать дольше минуты).
 * Возвращает массив {ok, chat, problems[], warnings[]} в порядке refs.
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
        ? 'бот не видит этот чат — он не добавлен туда или ID неверный'
        : 'ошибка Telegram: ' + esc_(gc.description));
      return;
    }
    r.chat = gc.result;
    if (r.chat.type === 'private') { r.problems.push('это личный чат, а не группа/канал'); return; }
    pending.push(i);
  });

  const memberResps = tgBatchChunked_(pending.map(function (i) {
    return { method: 'getChatMember', payload: { chat_id: results[i].chat.id, user_id: botId } };
  }));
  memberResps.forEach(function (gm, k) {
    const r = results[pending[k]];
    if (!gm.ok) { r.problems.push('не удалось получить права бота: ' + esc_(gm.description)); return; }
    evaluateRights_(r, r.chat, gm.result);
  });

  results.forEach(function (r) { r.ok = !!r.chat && r.problems.length === 0; });
  return results;
}

function checkChatAccess_(ref) { return checkChatsAccess_([ref])[0]; }

/** Чистая логика прав (без запросов) — переиспользуется и в уведомлениях my_chat_member. */
function evaluateRights_(r, chat, m) {
  if (m.status === 'left') { r.problems.push('бот не состоит в этом чате'); return r; }
  if (m.status === 'kicked') { r.problems.push('бот удалён/заблокирован в этом чате'); return r; }

  if (chat.type === 'channel') {
    if (m.status !== 'administrator') r.problems.push('в канале бот должен быть <b>администратором</b>');
    else if (!m.can_post_messages) r.problems.push('у бота нет права «Публикация сообщений» (Post messages)');
    return r;
  }
  const isAdm = m.status === 'administrator' || m.status === 'creator';
  if (m.status === 'restricted' && !m.can_send_messages) {
    r.problems.push('боту запрещено отправлять сообщения в этой группе');
  } else if (m.status === 'member' && chat.permissions && chat.permissions.can_send_messages === false) {
    r.problems.push('участникам группы запрещено писать — сделайте бота администратором');
  }
  if (!isAdm && chat.slow_mode_delay) {
    r.warnings.push('включён медленный режим (' + chat.slow_mode_delay + ' с) — на бота-не-админа он действует');
  }
  if (!isAdm && chat.permissions && chat.permissions.can_send_photos === false) {
    r.warnings.push('участникам запрещены фото — посты с медиа могут не пройти');
  }
  return r;
}
