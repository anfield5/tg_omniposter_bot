/**
 * ============================== ПАРСЕРЫ ==============================
 * Чистые функции без обращений к Telegram/Sheets — легко тестируются.
 */

const POST_FLAG_ALIASES = {
  list: 'list', chat: 'chat', start: 'start', end: 'end', mix: 'mix',
  regularity: 'regularity', reg: 'regularity', every: 'regularity',
};

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** "2h" | "0.75h" | "45m" | "1d" | "1,5ч" → минуты */
function parseDuration_(s) {
  const m = String(s).trim().toLowerCase().replace(',', '.')
    .match(/^(\d+(?:\.\d+)?)\s*(m|min|мин|м|h|ч|d|д)?$/);
  if (!m) throw new UserError('Неверный интервал «' + esc_(s) + '». Примеры: <code>2h</code>, <code>0.75h</code>, <code>45m</code>, <code>1d</code>');
  const u = m[2] || 'h';
  const mult = /^(m|min|мин|м)$/.test(u) ? 1 : /^(d|д)$/.test(u) ? 1440 : 60;
  const minutes = Math.round(parseFloat(m[1]) * mult);
  if (minutes < CFG.MIN_INTERVAL_MIN) throw new UserError('Минимальный интервал — ' + CFG.MIN_INTERVAL_MIN + ' мин');
  return minutes;
}

/** "24.10.2026 14:00" (в часовом поясе tz) | "now" → {ms, now} */
function parseDateTime_(s, tz) {
  s = String(s).trim();
  if (/^(now|сейчас)$/i.test(s)) return { ms: Date.now(), now: true };
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[\sT,]+(\d{1,2}):(\d{2})$/);
  if (!m) throw new UserError('Неверная дата «' + esc_(s) + '». Формат: <code>24.10.2026 14:00</code> или <code>now</code>');
  const d = +m[1], mo = +m[2], y = +m[3], h = +m[4], mi = +m[5];
  const norm = pad2_(d) + '.' + pad2_(mo) + '.' + y + ' ' + pad2_(h) + ':' + pad2_(mi);
  const bad = new UserError('Несуществующая дата/время «' + esc_(s) + '»');
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw bad;
  const date = Utilities.parseDate(norm, tz, 'dd.MM.yyyy HH:mm');
  // parseDate «прощает» 31.02 → 03.03, а также время в «дыре» перевода часов — ловим обратным форматированием
  if (Utilities.formatDate(date, tz, 'dd.MM.yyyy HH:mm') !== norm) throw bad;
  return { ms: date.getTime(), now: false };
}

function unquote_(v) {
  return String(v).trim().replace(/^["'«“„]+/, '').replace(/["'»”“]+$/, '').trim();
}

/** @username | -100123 | 123 | https://t.me/name | https://t.me/c/123/45 → ссылка на чат для Bot API */
function normalizeChatRef_(s) {
  s = String(s || '').trim();
  let m = s.match(/t\.me\/c\/(\d+)/i);
  if (m) return '-100' + m[1];
  m = s.match(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (m) return '@' + m[1];
  if (/^-?\d+$/.test(s)) return s;
  m = s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/);
  if (m) return '@' + m[1];
  throw new UserError('Неверный ID чата «' + esc_(s) + '». Пример: <code>-1001234567890</code> или <code>@channel</code>');
}

function validateListName_(s) {
  s = String(s || '').trim();
  if (!s) throw new UserError('Укажите имя списка');
  if (!/^[\p{L}\p{N}_.\-]{1,64}$/u.test(s)) throw new UserError('Имя списка: одно слово (буквы, цифры, _ . -), до 64 символов');
  return s;
}

/**
 * Переносит entities (жирный, ссылки и т.д.) из исходного сообщения в вырезанный фрагмент.
 * Смещения Telegram — в UTF-16, как и индексы строк JS, поэтому арифметика корректна.
 */
function shiftEntities_(entities, start, len) {
  return (entities || []).map(function (e) {
    const s = Math.max(e.offset - start, 0);
    const end = Math.min(e.offset + e.length - start, len);
    if (end <= s) return null;
    const c = {};
    Object.keys(e).forEach(function (k) { c[k] = e[k]; });
    c.offset = s;
    c.length = end - s;
    return c;
  }).filter(Boolean);
}

/**
 * Разбор /post.
 *   /post <текст> (-list имя | -chat id) [-start "дата"|now] [-regularity 2h] [-end "дата"] [-mix 0.75h in 2]
 * Текст — всё до первого флага. Флаги принимают и «—» (iOS заменяет «--» на длинное тире).
 */
function parsePostArgs_(raw, entities, nowMs, tz) {
  raw = String(raw || '');
  const cm = raw.match(/^\/post(?:@[A-Za-z0-9_]+)?/i);
  const base = cm ? cm[0].length : 0;
  const body = raw.slice(base);

  const re = /(^|\s)(?:--?|—|–)(list|chat|start|regularity|reg|every|end|mix)(?=\s|$)/gi;
  const marks = [];
  let m;
  while ((m = re.exec(body))) {
    marks.push({ name: POST_FLAG_ALIASES[m[2].toLowerCase()], from: m.index + m[1].length, valFrom: m.index + m[0].length });
  }

  const flags = {};
  marks.forEach(function (mk, i) {
    const end = i + 1 < marks.length ? marks[i + 1].from : body.length;
    if (flags[mk.name] !== undefined) throw new UserError('Флаг <code>-' + mk.name + '</code> указан дважды');
    flags[mk.name] = unquote_(body.slice(mk.valFrom, end));
  });
  Object.keys(flags).forEach(function (k) {
    if (!flags[k]) throw new UserError('У флага <code>-' + k + '</code> нет значения');
  });

  const rawText = body.slice(0, marks.length ? marks[0].from : body.length);
  const lead = rawText.length - rawText.replace(/^\s+/, '').length;
  const text = rawText.trim();
  const ents = shiftEntities_(entities, base + lead, text.length);

  if (flags.list === undefined && flags.chat === undefined) {
    throw new UserError('Укажите, куда постить: <code>-list имя</code> или <code>-chat id</code>');
  }
  if (flags.list !== undefined && flags.chat !== undefined) throw new UserError('Нужно что-то одно: <code>-list</code> или <code>-chat</code>');
  if (flags.regularity && flags.mix) throw new UserError('<code>-regularity</code> и <code>-mix</code> взаимоисключающие');

  const start = flags.start ? parseDateTime_(flags.start, tz) : { ms: nowMs, now: true };
  if (start.now) start.ms = nowMs;
  if (!start.now && start.ms < nowMs - 60 * 1000) throw new UserError('Время старта ' + esc_(flags.start) + ' уже прошло');

  let interval = 0, mixCount = 0;
  if (flags.regularity) interval = parseDuration_(flags.regularity);
  if (flags.mix) {
    if (flags.chat !== undefined) throw new UserError('<code>-mix</code> работает только со списком (<code>-list</code>)');
    const mm = flags.mix.match(/^(.+?)\s+(?:in|из|в)\s+(\d+)$/i);
    if (!mm) throw new UserError('Формат: <code>-mix 0.75h in 2</code>');
    interval = parseDuration_(mm[1]);
    mixCount = parseInt(mm[2], 10);
    if (mixCount < 1) throw new UserError('В <code>-mix … in N</code> N должно быть ≥ 1');
  }

  let endMs = null;
  if (flags.end) {
    if (!interval) throw new UserError('<code>-end</code> имеет смысл только вместе с <code>-regularity</code> или <code>-mix</code>');
    endMs = parseDateTime_(flags.end, tz).ms;
    if (endMs < start.ms) throw new UserError('Дата окончания раньше даты старта');
  }

  return {
    text: text,
    entities: ents,
    target: flags.list !== undefined ? { type: 'list', value: flags.list } : { type: 'chat', value: flags.chat },
    startMs: start.ms,
    startNow: start.now,
    interval: interval,
    mixCount: mixCount,
    endMs: endMs,
  };
}

/**
 * Следующий запуск после выполненного. Пропущенные слоты (если Google задержал триггер)
 * не «досылаются» пачкой, а пропускаются. end — включительно.
 * Возвращает ms или null (задача завершена).
 */
function computeNextRun_(prevRunMs, intervalMin, endMs, nowMs) {
  if (!intervalMin) return null;
  const step = intervalMin * 60000;
  let next = prevRunMs + step;
  if (next <= nowMs) next += (Math.floor((nowMs - next) / step) + 1) * step;
  if (endMs && next > endMs) return null;
  return next;
}

/** Сколько всего публикаций будет у задачи с концом (для подтверждения). */
function countRuns_(startMs, intervalMin, endMs) {
  if (!intervalMin) return 1;
  if (!endMs) return Infinity;
  return Math.floor((endMs - startMs) / (intervalMin * 60000)) + 1;
}

/** k случайных элементов (частичный Фишер–Йетс). */
function sample_(arr, k) {
  const a = arr.slice();
  if (k >= a.length) return a;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a.slice(0, k);
}
