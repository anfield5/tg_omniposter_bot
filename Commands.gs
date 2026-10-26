/**
 * ============================== COMMANDS ==============================
 * The bot accepts commands only in private chat and only from ADMIN_IDS.
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
    reply_(msg.chat.id, '⛔ Access denied.\nYour Telegram ID: <code>' + msg.from.id + '</code>\n' +
      'The bot owner can add it to ADMIN_IDS.');
    return;
  }

  const text = msg.text || msg.caption || '';
  const cm = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)/);
  if (!cm) { reply_(msg.chat.id, 'I only understand commands. See /help'); return; }

  const handler = getCommands_()[cm[1].toLowerCase()];
  if (!handler) { reply_(msg.chat.id, 'Unknown command. See /help'); return; }

  try {
    handler(msg, text.slice(cm[0].length).trim());
  } catch (e) {
    if (e instanceof UserError) reply_(msg.chat.id, '❌ ' + e.message);
    else { console.error(e.stack); reply_(msg.chat.id, '⚠️ Internal error: ' + esc_(e.message)); }
  }
}

// ------------------------------- help -------------------------------

function cmdHelp_(msg) {
  reply_(msg.chat.id, [
    '<b>📋 Lists</b>',
    '/addlist <i>name</i> — create a list',
    '/removelist <i>name</i> — delete a list, its chats, and stop its jobs',
    '/lists — all lists',
    '/showlist <i>name</i> — chats in a list',
    '',
    '<b>💬 Chats</b>',
    '/addchat <i>id [id2 …] name</i> — add chat(s) to a list',
    '/removechat <i>id name</i> — remove a chat from a list',
    '/removechat <i>id</i> — remove a chat from all lists',
    '/checkchats <i>[name]</i> — check the bot\'s permissions',
    'ID: <code>-1001234567890</code>, <code>@channel</code> or a t.me link. Add the bot to a channel/group and it will send you the ID.',
    '',
    '<b>📤 Posting</b>',
    '<code>/post hello hello -list news -start 24.10.2026 14:00 -regularity 2h -end 26.11.2026 12:00</code>',
    '<code>/post hi, andrew -list news -start 24.10.2026 14:00 -mix 0.75h in 2</code>',
    '<code>/post hi -chat -1001234567890 -start now -regularity 2h</code>',
    '• no <code>-regularity</code>/<code>-mix</code> — one-time post; no <code>-start</code> — now',
    '• <code>-mix X in N</code>: first post to all chats, then every X to N random chats',
    '• text formatting (bold, links…) is preserved',
    '• photo/video: send media with the caption <code>/post text -list …</code> or reply <code>/post -list …</code> to any message',
    '',
    '<b>⏱ Jobs</b>',
    '/jobs — active jobs',
    '/pausejob <i>N</i>, /resumejob <i>N</i>, /stopjob <i>N</i>',
    '/version — bot version',
    '',
    'Time zone: <code>' + esc_(tz_()) + '</code>. Post log: Google Sheet, "Log" tab.',
  ].join('\n'));
}

function cmdVersion_(msg) {
  reply_(msg.chat.id, '🤖 <b>Autopost Bot</b> v' + VERSION + ' (' + RELEASE_DATE + ')\n' +
    'Mode: ' + esc_(prop_('MODE') || 'not configured') + ' · time zone: ' + esc_(tz_()));
}

// ------------------------------- lists -------------------------------

function cmdAddList_(msg, args) {
  const name = validateListName_(args);
  withLock_(function () {
    if (findList_(name)) throw new UserError('List "' + esc_(name) + '" already exists');
    appendRows_('lists', [{ list_name: name, created_at: new Date() }]);
  });
  reply_(msg.chat.id, '✅ List <b>' + esc_(name) + '</b> created.\nAdd chats: <code>/addchat id ' + esc_(name) + '</code>');
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
        j.status = 'stopped'; j.last_error = 'list deleted'; saveJob_(j); stopped++;
      }
    });
    invalidateSchedule_();
    return { chats: chats.length, stopped: stopped };
  });
  reply_(msg.chat.id, '🗑 List <b>' + esc_(name) + '</b> deleted. Chats removed: ' + res.chats + ', jobs stopped: ' + res.stopped);
}

function cmdLists_(msg) {
  const lists = readAll_('lists');
  if (!lists.length) { reply_(msg.chat.id, 'No lists yet. Create one: <code>/addlist name</code>'); return; }
  const chats = readAll_('chats');
  const jobs = readJobs_();
  reply_(msg.chat.id, '<b>Lists:</b>\n' + lists.map(function (l) {
    const n = lc_(l.list_name);
    const c = chats.filter(function (x) { return lc_(x.list_name) === n; }).length;
    const j = jobs.filter(function (x) { return x.target_type === 'list' && lc_(x.target) === n && x.status === 'active'; }).length;
    return '• <b>' + esc_(l.list_name) + '</b> — chats: ' + c + ', active jobs: ' + j;
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
    : 'empty — <code>/addchat id ' + esc_(name) + '</code>'));
}

// ------------------------------- chats -------------------------------

function cmdAddChat_(msg, args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new UserError('Usage: <code>/addchat id [id2 …] listname</code>');
  const name = validateListName_(tokens.pop());
  requireList_(name); // fail fast, before any Telegram requests

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
    const list = requireList_(name); // the list may have been deleted while we were checking
    const existing = chatsInList_(name);
    const rows = [];
    toAdd.forEach(function (a) {
      const c = a.chk.chat;
      const label = esc_(c.title || c.username || c.id) + ' <code>' + c.id + '</code>';
      const dup = existing.concat(rows).some(function (x) { return String(x.chat_id) === String(c.id); });
      if (dup) { lines.push('ℹ️ ' + label + ' is already in the list'); return; }
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
  if (tokens.length < 1 || tokens.length > 2) throw new UserError('Usage: <code>/removechat id [listname]</code>');
  const ref = normalizeChatRef_(tokens[0]);
  const listName = tokens[1] ? validateListName_(tokens[1]) : null;

  const removed = withLock_(function () {
    if (listName) requireList_(listName);
    const rows = readAll_('chats').filter(function (c) {
      return chatMatches_(c, ref) && (!listName || lc_(c.list_name) === lc_(listName));
    });
    if (!rows.length) throw new UserError('Chat <code>' + esc_(ref) + '</code> not found' + (listName ? ' in list "' + esc_(listName) + '"' : ' in any list'));
    deleteRows_('chats', rows);
    return rows.map(function (r) { return r.list_name; });
  });
  reply_(msg.chat.id, '🗑 Chat <code>' + esc_(ref) + '</code> removed from: ' + removed.map(esc_).join(', '));
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
  if (!ids.length) { reply_(msg.chat.id, 'No chats'); return; }

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
  reply_(msg.chat.id, '<b>Permission check: ' + ok + '/' + ids.length + ' OK</b>\n' + lines.join('\n'));
}

/** The bot was added/removed or its rights changed — report the chat ID and status. */
function onMyChatMember_(upd) {
  const chat = upd.chat;
  if (!chat || chat.type === 'private') return;
  const inLists = readAll_('chats').filter(function (c) { return String(c.chat_id) === String(chat.id); })
    .map(function (c) { return c.list_name; });
  // notify only about admin actions or chats from our lists (so strangers can't spam admins)
  if (!(upd.from && isAdmin_(upd.from.id)) && !inLists.length) return;

  const m = upd.new_chat_member;
  const st = m.status;
  const canPost = evaluateRights_({ problems: [], warnings: [] }, chat, m).problems.length === 0;

  const head = (st === 'left' || st === 'kicked') ? '🚪 Bot removed from chat' : '🔔 Bot status changed';
  const lines = [
    head + ': <b>' + esc_(chat.title || chat.username || chat.id) + '</b> (' + chatTypeName_(chat.type) + ')',
    'ID: <code>' + chat.id + '</code>',
    'Status: ' + st + ' · can post: ' + (canPost ? 'yes ✅' : 'no ❌'),
  ];
  if (chat.type === 'channel' && st === 'member') lines.push('In a channel the bot must be an admin with the "Post messages" right.');
  if (inLists.length) lines.push('In lists: ' + inLists.map(esc_).join(', '));
  else if (canPost) lines.push('Add to a list: <code>/addchat ' + chat.id + ' listname</code>');
  notifyAdmins_(lines.join('\n'));
}

// -------------------------------- post --------------------------------

function cmdPost_(msg) {
  const raw = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const now = Date.now();
  const p = parsePostArgs_(raw, entities, now, tz_());

  // Content kind
  let kind, srcChat = '', srcMsg = '';
  if (msg.reply_to_message) {
    if (p.text) throw new UserError('When replying to a message, no text is needed — the bot copies the original message as is');
    kind = 'copy'; srcChat = String(msg.chat.id); srcMsg = String(msg.reply_to_message.message_id);
  } else if (!msg.text) {
    kind = 'copy_caption'; srcChat = String(msg.chat.id); srcMsg = String(msg.message_id); // media with a command caption
    if (p.text.length > 1024) throw new UserError('Media caption is limited to 1024 characters');
  } else {
    if (!p.text) throw new UserError('Empty post text. Example: <code>/post Hello! -list news</code>');
    if (p.text.length > 4096) throw new UserError('Text is longer than 4096 characters');
    kind = 'text';
  }

  // Target
  let target, targetTitle = '', chatsCount;
  if (p.target.type === 'list') {
    target = requireList_(p.target.value).list_name;
    chatsCount = chatsInList_(target).length;
  } else {
    const chk = checkChatAccess_(normalizeChatRef_(p.target.value));
    if (!chk.ok) throw new UserError('Chat <code>' + esc_(p.target.value) + '</code>: ' + chk.problems.join('; '));
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

  const until = p.endMs ? ' until ' + fmtDate_(p.endMs) : ' with no end date';
  const lines = [
    '✅ <b>Job #' + job.job_id + '</b> created',
    'Target: ' + (p.target.type === 'list'
      ? 'list <b>' + esc_(target) + '</b> (' + chatsCount + ' chat' + (chatsCount === 1 ? '' : 's') + ')'
      : 'chat <b>' + esc_(targetTitle) + '</b> <code>' + target + '</code>'),
    'First post: ' + (p.startNow ? 'within a minute' : fmtDate_(p.startMs)) + (p.mixCount ? ' — to all chats' : ''),
  ];
  if (p.mixCount) lines.push('Then every ' + fmtInterval_(p.interval) + ' to ' + p.mixCount + ' random chat(s)' + until);
  else if (p.interval) lines.push('Repeat: every ' + fmtInterval_(p.interval) + until);
  else lines.push('One-time post');
  const total = countRuns_(p.startMs, p.interval, p.endMs);
  if (p.interval && total !== Infinity) lines.push('Total posts: ' + total);
  if (p.target.type === 'list' && !chatsCount) lines.push('⚠️ The list is empty — add chats before the start time');
  if (kind !== 'text') lines.push('ℹ️ Do not delete the original message in this chat — the bot copies it');
  lines.push('Stop: /stopjob ' + job.job_id);
  reply_(msg.chat.id, lines.join('\n'));
}

// -------------------------------- jobs --------------------------------

function describeJob_(j) {
  const icon = { active: '▶️', paused: '⏸', done: '✅', stopped: '⏹' }[j.status] || '•';
  const where = j.target_type === 'list' ? 'list ' + esc_(j.target) : 'chat ' + esc_(j.target_title || j.target);
  const sched = j.mix_count
    ? 'mix every ' + fmtInterval_(j.interval_min) + ' to ' + j.mix_count
    : j.interval_min ? 'every ' + fmtInterval_(j.interval_min) : 'one-time';
  return icon + ' <b>#' + j.job_id + '</b> · ' + where + ' · ' + sched + (j.end_ms ? ' until ' + fmtDate_(j.end_ms) : '') +
    '\n   "' + esc_(j.preview) + '"' +
    '\n   next: ' + (j.next_run_ms ? fmtDate_(j.next_run_ms) : '—') + ' · sent: ' + j.runs +
    (j.last_error ? '\n   ⚠️ ' + esc_(String(j.last_error).slice(0, 150)) : '');
}

function cmdJobs_(msg) {
  const jobs = readJobs_();
  const live = jobs.filter(isLive_);
  const finished = jobs.length - live.length;
  reply_(msg.chat.id, live.length
    ? '<b>Jobs (' + live.length + '):</b>\n' + live.map(describeJob_).join('\n') + (finished ? '\n\nFinished/stopped: ' + finished : '')
    : 'No active jobs' + (finished ? ' (finished: ' + finished + ')' : ''));
}

function setJobStatus_(msg, args, allowedFrom, to) {
  const j = withLock_(function () {
    const job = findJob_(args);
    if (allowedFrom.indexOf(job.status) === -1) throw new UserError('Job #' + job.job_id + ' is currently "' + job.status + '"');
    job.status = to;
    if (to === 'active' && job.next_run_ms && job.next_run_ms < Date.now()) {
      // after a pause, missed posts are not sent: jump to the next future slot (a one-time post goes out now)
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
