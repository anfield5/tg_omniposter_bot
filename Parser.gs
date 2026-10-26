/**
 * =============================== PARSERS ===============================
 * Pure functions with no Telegram/Sheets access — easy to test.
 */

const POST_FLAG_ALIASES = {
  list: 'list', chat: 'chat', start: 'start', end: 'end', mix: 'mix',
  regularity: 'regularity', reg: 'regularity', every: 'regularity',
};

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** "2h" | "0.75h" | "45m" | "1d" | "1,5h" → minutes */
function parseDuration_(s) {
  const m = String(s).trim().toLowerCase().replace(',', '.')
    .match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/);
  if (!m) throw new UserError('Invalid interval "' + esc_(s) + '". Examples: <code>2h</code>, <code>0.75h</code>, <code>45m</code>, <code>1d</code>');
  const u = m[2] || 'h';
  const mult = u === 'm' || u === 'min' ? 1 : u === 'd' ? 1440 : 60;
  const minutes = Math.round(parseFloat(m[1]) * mult);
  if (minutes < CFG.MIN_INTERVAL_MIN) throw new UserError('The minimum interval is ' + CFG.MIN_INTERVAL_MIN + ' min');
  return minutes;
}

/** "24.10.2026 14:00" (in time zone tz) | "now" → {ms, now} */
function parseDateTime_(s, tz) {
  s = String(s).trim();
  if (/^now$/i.test(s)) return { ms: Date.now(), now: true };
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[\sT,]+(\d{1,2}):(\d{2})$/);
  if (!m) throw new UserError('Invalid date "' + esc_(s) + '". Format: <code>24.10.2026 14:00</code> or <code>now</code>');
  const d = +m[1], mo = +m[2], y = +m[3], h = +m[4], mi = +m[5];
  const norm = pad2_(d) + '.' + pad2_(mo) + '.' + y + ' ' + pad2_(h) + ':' + pad2_(mi);
  const bad = new UserError('Date/time does not exist: "' + esc_(s) + '"');
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw bad;
  const date = Utilities.parseDate(norm, tz, 'dd.MM.yyyy HH:mm');
  // parseDate is lenient (31.02 → 03.03, times inside a DST gap) — catch it by formatting back
  if (Utilities.formatDate(date, tz, 'dd.MM.yyyy HH:mm') !== norm) throw bad;
  return { ms: date.getTime(), now: false };
}

function unquote_(v) {
  return String(v).trim().replace(/^["'«“„]+/, '').replace(/["'»”“]+$/, '').trim();
}

/** @username | -100123 | 123 | https://t.me/name | https://t.me/c/123/45 → chat reference for the Bot API */
function normalizeChatRef_(s) {
  s = String(s || '').trim();
  let m = s.match(/t\.me\/c\/(\d+)/i);
  if (m) return '-100' + m[1];
  m = s.match(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (m) return '@' + m[1];
  if (/^-?\d+$/.test(s)) return s;
  m = s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/);
  if (m) return '@' + m[1];
  throw new UserError('Invalid chat ID "' + esc_(s) + '". Example: <code>-1001234567890</code> or <code>@channel</code>');
}

function validateListName_(s) {
  s = String(s || '').trim();
  if (!s) throw new UserError('Specify a list name');
  if (!/^[\p{L}\p{N}_.\-]{1,64}$/u.test(s)) throw new UserError('List name: a single word (letters, digits, _ . -), up to 64 characters');
  return s;
}

/**
 * Moves entities (bold, links, etc.) from the original message onto the extracted fragment.
 * Telegram offsets are in UTF-16 code units, same as JS string indices, so the math is exact.
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
 * Parses /post.
 *   /post <text> (-list name | -chat id) [-start "date"|now] [-regularity 2h] [-end "date"] [-mix 0.75h in 2]
 * The text is everything before the first flag. Flags also accept "—" (iOS turns "--" into an em dash).
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
    if (flags[mk.name] !== undefined) throw new UserError('Flag <code>-' + mk.name + '</code> is specified twice');
    flags[mk.name] = unquote_(body.slice(mk.valFrom, end));
  });
  Object.keys(flags).forEach(function (k) {
    if (!flags[k]) throw new UserError('Flag <code>-' + k + '</code> has no value');
  });

  const rawText = body.slice(0, marks.length ? marks[0].from : body.length);
  const lead = rawText.length - rawText.replace(/^\s+/, '').length;
  const text = rawText.trim();
  const ents = shiftEntities_(entities, base + lead, text.length);

  if (flags.list === undefined && flags.chat === undefined) {
    throw new UserError('Specify where to post: <code>-list name</code> or <code>-chat id</code>');
  }
  if (flags.list !== undefined && flags.chat !== undefined) throw new UserError('Use only one of <code>-list</code> or <code>-chat</code>');
  if (flags.regularity && flags.mix) throw new UserError('<code>-regularity</code> and <code>-mix</code> are mutually exclusive');

  const start = flags.start ? parseDateTime_(flags.start, tz) : { ms: nowMs, now: true };
  if (start.now) start.ms = nowMs;
  if (!start.now && start.ms < nowMs - 60 * 1000) throw new UserError('Start time ' + esc_(flags.start) + ' is in the past');

  let interval = 0, mixCount = 0;
  if (flags.regularity) interval = parseDuration_(flags.regularity);
  if (flags.mix) {
    if (flags.chat !== undefined) throw new UserError('<code>-mix</code> only works with a list (<code>-list</code>)');
    const mm = flags.mix.match(/^(.+?)\s+in\s+(\d+)$/i);
    if (!mm) throw new UserError('Format: <code>-mix 0.75h in 2</code>');
    interval = parseDuration_(mm[1]);
    mixCount = parseInt(mm[2], 10);
    if (mixCount < 1) throw new UserError('In <code>-mix … in N</code>, N must be ≥ 1');
  }

  let endMs = null;
  if (flags.end) {
    if (!interval) throw new UserError('<code>-end</code> only makes sense with <code>-regularity</code> or <code>-mix</code>');
    endMs = parseDateTime_(flags.end, tz).ms;
    if (endMs < start.ms) throw new UserError('End date is before the start date');
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
 * Next run after a completed one. Missed slots (if Google delayed the trigger)
 * are skipped, not sent as a burst. end is inclusive.
 * Returns ms, or null if the job is finished.
 */
function computeNextRun_(prevRunMs, intervalMin, endMs, nowMs) {
  if (!intervalMin) return null;
  const step = intervalMin * 60000;
  let next = prevRunMs + step;
  if (next <= nowMs) next += (Math.floor((nowMs - next) / step) + 1) * step;
  if (endMs && next > endMs) return null;
  return next;
}

/** Total number of posts for a job with an end date (for the confirmation message). */
function countRuns_(startMs, intervalMin, endMs) {
  if (!intervalMin) return 1;
  if (!endMs) return Infinity;
  return Math.floor((endMs - startMs) / (intervalMin * 60000)) + 1;
}

/** k random elements (partial Fisher–Yates). */
function sample_(arr, k) {
  const a = arr.slice();
  if (k >= a.length) return a;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a.slice(0, k);
}
