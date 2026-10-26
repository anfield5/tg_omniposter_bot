/**
 * ============================== КОМАНДЫ ==============================
 * Бот принимает команды только в личке и только от ADMIN_IDS.
 */

function getCommands_() {
  return {
    start: cmdHelp_, help: cmdHelp_,
    addlist: cmdAddList_, removelist: cmdRemoveList_, lists: cmdLists_, showlist: cmdShowList_, list: cmdShowList_,
    addchat: cmdAddChat_, removechat: cmdRemoveChat_, checkchats: cmdCheckChats_,
    version: cmdVersion_,
    post: cmdPost_, jobs: cmdJobs_, stopjob: cmdStopJob_, pausejob: cmdPauseJob_, resumejob: cmdResumeJob_,
  };
}

function handleUpdate_(u) {
  if (u.my_chat_member) return onMyChatMember_(u.my_chat_member);

  const msg = u.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from) return;

  if (!isAdmin_(msg.from.id)) {
    reply_(msg.chat.id, '⛔ Нет доступа.\nВаш Telegram ID: <code>' + msg.from.id + '</code>\n' +
      'Владелец бота может добавить его в ADMIN_IDS.');
    return;
  }

  const text = msg.text || msg.caption || '';
  const cm = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)/);
  if (!cm) { reply_(msg.chat.id, 'Я понимаю только команды. Список — /help'); return; }

  const handler = getCommands_()[cm[1].toLowerCase()];
  if (!handler) { reply_(msg.chat.id, 'Неизвестная команда. Список — /help'); return; }

  try {
    handler(msg, text.slice(cm[0].length).trim());
  } catch (e) {
    if (e instanceof UserError) reply_(msg.chat.id, '❌ ' + e.message);
    else { console.error(e.stack); reply_(msg.chat.id, '⚠️ Внутренняя ошибка: ' + esc_(e.message)); }
  }
}

// ------------------------------- help -------------------------------

function cmdHelp_(msg) {
  reply_(msg.chat.id, [
    '<b>📋 Списки</b>',
    '/addlist <i>name</i> — создать список',
    '/removelist <i>name</i> — удалить список, его чаты и остановить его задачи',
    '/lists — все списки',
    '/showlist <i>name</i> — чаты в списке',
    '',
    '<b>💬 Чаты</b>',
    '/addchat <i>id [id2 …] name</i> — добавить чат(ы) в список',
    '/removechat <i>id name</i> — убрать чат из списка',
    '/removechat <i>id</i> — убрать чат из всех списков',
    '/checkchats <i>[name]</i> — проверить права бота',
    'ID: <code>-1001234567890</code>, <code>@channel</code> или ссылка t.me. Добавьте бота в канал/группу — он сам пришлёт ID.',
    '',
    '<b>📤 Публикации</b>',
    '<code>/post hello hello -list news -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00</code>',
    '<code>/post hi, andrew -list news -start 24.10.2026 14:00 -mix 0.75h in 2</code>',
    '<code>/post hi -chat -1001234567890 -start now -regularity 2h</code>',
    '• без <code>-regularity</code>/<code>-mix</code> — разовый пост; без <code>-start</code> — сейчас',
    '• <code>-mix X in N</code>: первый раз во все чаты, затем каждые X в N случайных',
    '• форматирование текста (жирный, ссылки…) сохраняется',
    '• фото/видео: отправьте медиа с подписью <code>/post текст -list …</code> или ответьте <code>/post -list …</code> на любое сообщение',
    '',
    '<b>⏱ Задачи</b>',
    '/jobs — активные задачи',
    '/pausejob <i>N</i>, /resumejob <i>N</i>, /stopjob <i>N</i>',
    '/version — версия бота',
    '',
    'Часовой пояс: <code>' + esc_(tz_()) + '</code>. Журнал публикаций — в Google-таблице, лист Log.',
  ].join('\n'));
}

function cmdVersion_(msg) {
  reply_(msg.chat.id, '🤖 <b>Autopost Bot</b> v' + VERSION + ' (' + RELEASE_DATE + ')\n' +
    'Режим: ' + esc_(prop_('MODE') || 'не настроен') + ' · часовой пояс: ' + esc_(tz_()));
}

// ------------------------------- lists -------------------------------

function cmdAddList_(msg, args) {
  const name = validateListName_(args);
  withLock_(function () {
    if (findList_(name)) throw new UserError('Список «' + esc_(name) + '» уже существует');
    appendRows_('lists', [{ list_name: name, created_at: new Date() }]);
  });
  reply_(msg.chat.id, '✅ Список <b>' + esc_(name) + '</b> создан.\nДобавляйте чаты: <code>/addchat id ' + esc_(name) + '</code>');
}

function cmdRemoveList_(msg, args) {
  const name = validateListName_(args);
  const res = withLock_(function () {
    const list = requireList_(name);
    const chats = chatsInList_(name);
    deleteRows_('chats', chats);
    deleteRows_('lists', [list]);
    let stopped = 0;
    readJobs_().forEach(function (j) {
      if (j.target_type === 'list' && lc_(j.target) === lc_(name) && isLive_(j)) {
        j.status = 'stopped'; j.last_error = 'список удалён'; saveJob_(j); stopped++;
      }
    });
    invalidateSchedule_();
    return { chats: chats.length, stopped: stopped };
  });
  reply_(msg.chat.id, '🗑 Список <b>' + esc_(name) + '</b> удалён. Чатов убрано: ' + res.chats + ', задач остановлено: ' + res.stopped);
}

function cmdLists_(msg) {
  const lists = readAll_('lists');
  if (!lists.length) { reply_(msg.chat.id, 'Списков пока нет. Создайте: <code>/addlist name</code>'); return; }
  const chats = readAll_('chats');
  const jobs = readJobs_();
  reply_(msg.chat.id, '<b>Списки:</b>\n' + lists.map(function (l) {
    const n = lc_(l.list_name);
    const c = chats.filter(function (x) { return lc_(x.list_name) === n; }).length;
    const j = jobs.filter(function (x) { return x.target_type === 'list' && lc_(x.target) === n && x.status === 'active'; }).length;
    return '• <b>' + esc_(l.list_name) + '</b> — чатов: ' + c + ', активных задач: ' + j;
  }).join('\n'));
}

function cmdShowList_(msg, args) {
  const name = validateListName_(args);
  requireList_(name);
  const chats = chatsInList_(name);
  reply_(msg.chat.id, '<b>' + esc_(name) + '</b> (' + chats.length + '):\n' + (chats.length
    ? chats.map(function (c) {
      return '• ' + esc_(c.title || '—') + ' · ' + chatTypeName_(c.type) + (c.username ? ' · @' + esc_(c.username) : '') +
        '\n   <code>' + c.chat_id + '</code>';
    }).join('\n')
    : 'пусто — <code>/addchat id ' + esc_(name) + '</code>'));
}

// ------------------------------- chats -------------------------------

function cmdAddChat_(msg, args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new UserError('Формат: <code>/addchat id [id2 …] listname</code>');
  const name = validateListName_(tokens.pop());
  requireList_(name); // ошибка до запросов в Telegram

  const lines = [];
  const refs = [];
  tokens.forEach(function (t) {
    try { refs.push(normalizeChatRef_(t)); } catch (e) { lines.push('❌ ' + e.message); }
  });
  const toAdd = [];
  checkChatsAccess_(refs).forEach(function (chk, i) {
    if (!chk.ok) lines.push('❌ <code>' + esc_(refs[i]) + '</code>: ' + chk.problems.join('; '));
    else toAdd.push({ chk: chk });
  });

  const list = withLock_(function () {
    const list = requireList_(name); // список могли удалить, пока шла проверка
    const existing = chatsInList_(name);
    const rows = [];
    toAdd.forEach(function (a) {
      const c = a.chk.chat;
      const label = esc_(c.title || c.username || c.id) + ' <code>' + c.id + '</code>';
      const dup = existing.concat(rows).some(function (x) { return String(x.chat_id) === String(c.id); });
      if (dup) { lines.push('ℹ️ ' + label + ' уже в списке'); return; }
      rows.push({ list_name: list.list_name, chat_id: String(c.id), title: c.title || '', type: c.type, username: c.username || '', added_at: new Date() });
      lines.push('✅ ' + label + ' (' + chatTypeName_(c.type) + ')' +
        (a.chk.warnings.length ? '\n   ⚠️ ' + a.chk.warnings.join('; ') : ''));
    });
    appendRows_('chats', rows);
    return list;
  });
  reply_(msg.chat.id, '<b>' + esc_(list.list_name) + '</b>:\n' + lines.join('\n'));
}

function cmdRemoveChat_(msg, args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 2) throw new UserError('Формат: <code>/removechat id [listname]</code>');
  const ref = normalizeChatRef_(tokens[0]);
  const listName = tokens[1] ? validateListName_(tokens[1]) : null;

  const removed = withLock_(function () {
    if (listName) requireList_(listName);
    const rows = readAll_('chats').filter(function (c) {
      return chatMatches_(c, ref) && (!listName || lc_(c.list_name) === lc_(listName));
    });
    if (!rows.length) throw new UserError('Чат <code>' + esc_(ref) + '</code> не найден' + (listName ? ' в списке «' + esc_(listName) + '»' : ' ни в одном списке'));
    deleteRows_('chats', rows);
    return rows.map(function (r) { return r.list_name; });
  });
  reply_(msg.chat.id, '🗑 Чат <code>' + esc_(ref) + '</code> удалён из: ' + removed.map(esc_).join(', '));
}

function cmdCheckChats_(msg, args) {
  let rows = readAll_('chats');
  if (args) {
    const name = validateListName_(args);
    requireList_(name);
    rows = rows.filter(function (c) { return lc_(c.list_name) === lc_(name); });
  }
  const uniq = {};
  rows.forEach(function (c) { (uniq[String(c.chat_id)] = uniq[String(c.chat_id)] || []).push(c); });
  const ids = Object.keys(uniq);
  if (!ids.length) { reply_(msg.chat.id, 'Чатов нет'); return; }

  let ok = 0;
  const checks = checkChatsAccess_(ids);
  const lines = ids.map(function (id, i) {
    const chk = checks[i];
    const title = esc_((chk.chat && chk.chat.title) || uniq[id][0].title || '—');
    const lists = uniq[id].map(function (c) { return c.list_name; }).join(', ');
    if (chk.ok) {
      ok++;
      return '✅ ' + title + ' <code>' + id + '</code> [' + esc_(lists) + ']' + (chk.warnings.length ? '\n   ⚠️ ' + chk.warnings.join('; ') : '');
    }
    return '❌ ' + title + ' <code>' + id + '</code> [' + esc_(lists) + ']\n   ' + chk.problems.join('; ');
  });
  reply_(msg.chat.id, '<b>Проверка прав: ' + ok + '/' + ids.length + ' ок</b>\n' + lines.join('\n'));
}

/** Бота добавили/удалили/поменяли права — сообщаем ID и статус. */
function onMyChatMember_(upd) {
  const chat = upd.chat;
  if (!chat || chat.type === 'private') return;
  const inLists = readAll_('chats').filter(function (c) { return String(c.chat_id) === String(chat.id); })
    .map(function (c) { return c.list_name; });
  // уведомляем только о действиях админа или о чатах из наших списков (чтобы посторонние не спамили)
  if (!(upd.from && isAdmin_(upd.from.id)) && !inLists.length) return;

  const st = upd.new_chat_member.status;
  const m = upd.new_chat_member;
  const canPost = evaluateRights_({ problems: [], warnings: [] }, chat, m).problems.length === 0;

  const head = (st === 'left' || st === 'kicked') ? '🚪 Бот удалён из чата' : '🔔 Статус бота в чате изменён';
  const lines = [
    head + ': <b>' + esc_(chat.title || chat.username || chat.id) + '</b> (' + chatTypeName_(chat.type) + ')',
    'ID: <code>' + chat.id + '</code>',
    'Статус: ' + st + ' · может публиковать: ' + (canPost ? 'да ✅' : 'нет ❌'),
  ];
  if (chat.type === 'channel' && st === 'member') lines.push('В канале бот должен быть админом с правом «Публикация сообщений».');
  if (inLists.length) lines.push('Состоит в списках: ' + inLists.map(esc_).join(', '));
  else if (canPost) lines.push('Добавить в список: <code>/addchat ' + chat.id + ' listname</code>');
  notifyAdmins_(lines.join('\n'));
}

// -------------------------------- post --------------------------------

function cmdPost_(msg) {
  const raw = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const now = Date.now();
  const p = parsePostArgs_(raw, entities, now, tz_());

  // Тип контента
  let kind, srcChat = '', srcMsg = '';
  if (msg.reply_to_message) {
    if (p.text) throw new UserError('При ответе на сообщение текст не нужен — бот скопирует исходное сообщение как есть');
    kind = 'copy'; srcChat = String(msg.chat.id); srcMsg = String(msg.reply_to_message.message_id);
  } else if (!msg.text) {
    kind = 'copy_caption'; srcChat = String(msg.chat.id); srcMsg = String(msg.message_id); // медиа с подписью-командой
    if (p.text.length > 1024) throw new UserError('Подпись к медиа — максимум 1024 символа');
  } else {
    if (!p.text) throw new UserError('Пустой текст поста. Пример: <code>/post Привет! -list news</code>');
    if (p.text.length > 4096) throw new UserError('Текст длиннее 4096 символов');
    kind = 'text';
  }

  // Цель
  let target, targetTitle = '', chatsCount;
  if (p.target.type === 'list') {
    target = requireList_(p.target.value).list_name;
    chatsCount = chatsInList_(target).length;
  } else {
    const chk = checkChatAccess_(normalizeChatRef_(p.target.value));
    if (!chk.ok) throw new UserError('Чат <code>' + esc_(p.target.value) + '</code>: ' + chk.problems.join('; '));
    target = String(chk.chat.id);
    targetTitle = chk.chat.title || chk.chat.username || '';
    chatsCount = 1;
  }

  const job = withLock_(function () {
    if (p.target.type === 'list') requireList_(target);
    const id = nextJobId_();
    const row = {
      job_id: id, status: 'active', kind: kind,
      target_type: p.target.type, target: target, target_title: targetTitle,
      preview: (p.text || '[' + kind + ']').replace(/\s+/g, ' ').slice(0, CFG.PREVIEW_LEN),
      payload: JSON.stringify({ text: p.text, entities: p.entities }),
      src_chat_id: srcChat, src_msg_id: srcMsg,
      start: new Date(p.startMs), interval_min: p.interval || '', end: p.endMs ? new Date(p.endMs) : '',
      mix_count: p.mixCount || '', next_run: new Date(p.startMs), runs: 0,
      last_run: '', last_error: '', created_at: new Date(), created_by: String(msg.from.id),
    };
    appendRows_('jobs', [row]);
    invalidateSchedule_();
    return row;
  });

  const lines = [
    '✅ <b>Задача #' + job.job_id + '</b> создана',
    'Куда: ' + (p.target.type === 'list'
      ? 'список <b>' + esc_(target) + '</b> (' + chatsCount + ' чат.)'
      : 'чат <b>' + esc_(targetTitle) + '</b> <code>' + target + '</code>'),
    'Первая публикация: ' + (p.startNow ? 'в течение минуты' : fmtDate_(p.startMs)) + (p.mixCount ? ' — во все чаты' : ''),
  ];
  if (p.mixCount) lines.push('Затем каждые ' + fmtInterval_(p.interval) + ' в ' + p.mixCount + ' случайных чат(а)' + (p.endMs ? ' до ' + fmtDate_(p.endMs) : ' без остановки'));
  else if (p.interval) lines.push('Повтор: каждые ' + fmtInterval_(p.interval) + (p.endMs ? ' до ' + fmtDate_(p.endMs) : ' без остановки'));
  else lines.push('Разовая публикация');
  const total = countRuns_(p.startMs, p.interval, p.endMs);
  if (p.interval && total !== Infinity) lines.push('Всего публикаций: ' + total);
  if (p.target.type === 'list' && !chatsCount) lines.push('⚠️ Список пока пуст — добавьте чаты до старта');
  if (kind !== 'text') lines.push('ℹ️ Не удаляйте исходное сообщение в этом чате — бот копирует именно его');
  lines.push('Остановить: /stopjob ' + job.job_id);
  reply_(msg.chat.id, lines.join('\n'));
}

// -------------------------------- jobs --------------------------------

function describeJob_(j) {
  const icon = { active: '▶️', paused: '⏸', done: '✅', stopped: '⏹' }[j.status] || '•';
  const where = j.target_type === 'list' ? 'список ' + esc_(j.target) : 'чат ' + esc_(j.target_title || j.target);
  const sched = j.mix_count
    ? 'mix каждые ' + fmtInterval_(j.interval_min) + ' в ' + j.mix_count
    : j.interval_min ? 'каждые ' + fmtInterval_(j.interval_min) : 'разово';
  return icon + ' <b>#' + j.job_id + '</b> · ' + where + ' · ' + sched + (j.end_ms ? ' до ' + fmtDate_(j.end_ms) : '') +
    '\n   «' + esc_(j.preview) + '»' +
    '\n   след.: ' + (j.next_run_ms ? fmtDate_(j.next_run_ms) : '—') + ' · отправок: ' + j.runs +
    (j.last_error ? '\n   ⚠️ ' + esc_(String(j.last_error).slice(0, 150)) : '');
}

function cmdJobs_(msg) {
  const jobs = readJobs_();
  const live = jobs.filter(isLive_);
  const finished = jobs.length - live.length;
  reply_(msg.chat.id, live.length
    ? '<b>Задачи (' + live.length + '):</b>\n' + live.map(describeJob_).join('\n') + (finished ? '\n\nЗавершённых/остановленных: ' + finished : '')
    : 'Активных задач нет' + (finished ? ' (завершённых: ' + finished + ')' : ''));
}

function setJobStatus_(msg, args, allowedFrom, to) {
  const j = withLock_(function () {
    const job = findJob_(args);
    if (allowedFrom.indexOf(job.status) === -1) throw new UserError('Задача #' + job.job_id + ' сейчас в статусе «' + job.status + '»');
    job.status = to;
    if (to === 'active' && job.next_run_ms && job.next_run_ms < Date.now()) {
      // после паузы не досылаем пропущенное: ближайший слот в будущем (разовый пост — сразу)
      job.next_run_ms = job.interval_min
        ? computeNextRun_(job.next_run_ms, job.interval_min, job.end_ms, Date.now())
        : Date.now();
      if (!job.next_run_ms) job.status = 'done';
    }
    saveJob_(job);
    invalidateSchedule_();
    return job;
  });
  reply_(msg.chat.id, describeJob_(j));
}

function cmdStopJob_(msg, args) { setJobStatus_(msg, args, ['active', 'paused'], 'stopped'); }
function cmdPauseJob_(msg, args) { setJobStatus_(msg, args, ['active'], 'paused'); }
function cmdResumeJob_(msg, args) { setJobStatus_(msg, args, ['paused'], 'active'); }
