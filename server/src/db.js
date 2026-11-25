'use strict';
/**
 * SQLite storage implementing the core PLATFORM.db contract.
 * Tables mirror core SCHEMA; times are stored as epoch ms. Changes mark tables "dirty"
 * so the mirror knows what to copy to Google Sheets.
 */
const Database = require('better-sqlite3');

const SQL_TYPE = { str: 'TEXT', num: 'REAL', time: 'INTEGER' };

class Db {
  /** @param {string} file path to the SQLite file (':memory:' for tests) @param {object} schema core SCHEMA */
  constructor(file, schema) {
    this.schema = schema;
    this.sql = new Database(file);
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('synchronous = NORMAL');
    this.dirty = new Set();
    for (const [table, def] of Object.entries(schema)) {
      const cols = Object.entries(def.cols).map(([c, t]) => `"${c}" ${SQL_TYPE[t]}`).join(', ');
      const extra = table === 'log' ? ', mirrored INTEGER NOT NULL DEFAULT 0' : '';
      this.sql.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols}${extra})`);
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS log_unmirrored ON log (mirrored, id)');
  }

  cols(table) { return Object.keys(this.schema[table].cols); }

  fromSql(table, r) {
    const o = { _id: r.id };
    for (const [c, t] of Object.entries(this.schema[table].cols)) {
      const v = r[c];
      o[c] = v === null || v === undefined ? (t === 'str' ? '' : null) : (t === 'str' ? String(v) : Number(v));
    }
    return o;
  }

  toSql(table, o) {
    return this.cols(table).map((c) => {
      const t = this.schema[table].cols[c];
      const v = o[c];
      if (v === undefined || v === null || v === '') return t === 'str' ? '' : null;
      return t === 'str' ? String(v) : Number(v);
    });
  }

  all(table) {
    return this.sql.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map((r) => this.fromSql(table, r));
  }

  insert(table, rows) {
    const cols = this.cols(table);
    const st = this.sql.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    this.sql.transaction(() => rows.forEach((r) => st.run(this.toSql(table, r))))();
    if (table !== 'log') this.dirty.add(table);
  }

  update(table, row) {
    if (!row._id) throw new Error('update: missing _id');
    const cols = this.cols(table);
    this.sql.prepare(`UPDATE "${table}" SET ${cols.map((c) => `"${c}"=?`).join(',')} WHERE id=?`).run(...this.toSql(table, row), row._id);
    if (table !== 'log') this.dirty.add(table);
  }

  remove(table, rows) {
    const st = this.sql.prepare(`DELETE FROM "${table}" WHERE id=?`);
    this.sql.transaction(() => rows.forEach((r) => st.run(r._id)))();
    if (table !== 'log') this.dirty.add(table);
  }

  /** Replaces lists/chats/jobs with data imported from the sheet (on takeover). */
  replaceAll(data) {
    this.sql.transaction(() => {
      for (const table of ['lists', 'chats', 'jobs']) {
        this.sql.exec(`DELETE FROM "${table}"`);
        if (data[table] && data[table].length) this.insert(table, data[table]);
      }
    })();
    this.dirty.clear();
  }

  unmirroredLog(limit) {
    return this.sql.prepare('SELECT * FROM log WHERE mirrored=0 ORDER BY id LIMIT ?').all(limit).map((r) => this.fromSql('log', r));
  }

  markMirrored(ids) {
    const st = this.sql.prepare('UPDATE log SET mirrored=1 WHERE id=?');
    this.sql.transaction(() => ids.forEach((id) => st.run(id)))();
  }

  getKv(k) { const r = this.sql.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? r.v : null; }
  setKv(k, v) { this.sql.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); }

  close() { this.sql.close(); }
}

module.exports = { Db };
