'use strict';
/**
 * Google Sheets access for the server: the Control sheet (backend switching), importing the data
 * on takeover, and mirroring SQLite → Sheets while the server is active.
 *
 * Wire format (same cells Apps Script uses):
 *   reads  — valueRenderOption UNFORMATTED_VALUE + dateTimeRenderOption SERIAL_NUMBER
 *   writes — valueInputOption RAW (strings stay literal text: no formulas/number/date coercion)
 *   time   — a serial date number (days since 1899-12-30, spreadsheet-local wall time) in a date-formatted column
 */
const { DateTime } = require('luxon');

const EPOCH_1899 = Date.UTC(1899, 11, 30);

function colLetter(n) { // 1 → A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

class SheetsStore {
  /**
   * @param api   thin Sheets API adapter (see createGoogleApi) — swapped for a fake in tests
   * @param core  {SCHEMA, CONTROL_SHEET, CONTROL_KEYS}
   */
  constructor(api, core) {
    this.api = api;
    this.schema = core.SCHEMA;
    this.controlSheet = core.CONTROL_SHEET;
    this.controlKeys = core.CONTROL_KEYS;
    this.tz = 'UTC';
  }

  async init() {
    const meta = await this.api.getSpreadsheet();
    this.tz = meta.timeZone || this.tz;
    const sheets = meta.sheets || {};
    for (const def of Object.values(this.schema)) {
      if (!(def.sheet in sheets)) throw new Error(`Sheet "${def.sheet}" not found — run setup() in Apps Script first`);
    }
    if (!(this.controlSheet in sheets)) throw new Error(`Sheet "${this.controlSheet}" not found — run setup() in Apps Script first`);
    this.sheetIds = sheets;
    return meta;
  }

  /** Date format on all time columns (whole column), so serial numbers written by the server display as dates. */
  async ensureTimeFormats() {
    const requests = [];
    for (const def of Object.values(this.schema)) {
      Object.keys(def.cols).forEach((c, i) => {
        if (def.cols[c] !== 'time') return;
        requests.push({
          repeatCell: {
            range: { sheetId: this.sheetIds[def.sheet], startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm:ss' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
      });
    }
    if (requests.length) await this.api.formatCells(requests);
  }

  // ------------------------------ conversions ------------------------------

  msToSerial(ms) {
    const local = DateTime.fromMillis(ms, { zone: this.tz });
    const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond);
    return (wall - EPOCH_1899) / 86400000;
  }

  serialToMs(serial) {
    const wall = DateTime.fromMillis(Math.round(serial * 86400000) + EPOCH_1899, { zone: 'UTC' });
    return wall.setZone(this.tz, { keepLocalTime: true }).toMillis();
  }

  toCell(type, v) {
    if (v === undefined || v === null || v === '') return '';
    if (type === 'time') return this.msToSerial(Number(v));
    if (type === 'num') return Number(v);
    return String(v);
  }

  fromCell(type, v) {
    if (v === undefined || v === null || v === '') return type === 'str' ? '' : null;
    if (type === 'time') { const n = Number(v); return isNaN(n) ? null : (n < 1e7 ? this.serialToMs(n) : n); }
    if (type === 'num') { const n = Number(v); return isNaN(n) ? null : n; }
    return String(v);
  }

  // -------------------------------- Control --------------------------------

  controlRange() { return `${this.controlSheet}!B2:B${this.controlKeys.length + 1}`; }

  async readControl() {
    const [vals] = await this.api.batchGet([this.controlRange()]);
    const ctl = {};
    this.controlKeys.forEach((k, i) => {
      const v = vals[i] && vals[i][0] !== undefined ? vals[i][0] : '';
      ctl[k] = ['epoch', 'server_heartbeat', 'switched_at'].includes(k) ? (v === '' ? null : Number(v)) : String(v);
    });
    return ctl;
  }

  async writeControl(patch) {
    const data = Object.entries(patch).map(([k, v]) => {
      const i = this.controlKeys.indexOf(k);
      if (i === -1) throw new Error('Unknown control key: ' + k);
      return { range: `${this.controlSheet}!B${i + 2}`, values: [[v === null || v === undefined ? '' : v]] };
    });
    await this.api.batchUpdate(data);
  }

  // ------------------------------ Data tables ------------------------------

  /** Reads lists/chats/jobs from the sheet → {lists:[…], chats:[…], jobs:[…], rowCounts}. */
  async importTables() {
    const tables = ['lists', 'chats', 'jobs'];
    const ranges = tables.map((t) => `${this.schema[t].sheet}!A2:${colLetter(Object.keys(this.schema[t].cols).length)}`);
    const results = await this.api.batchGet(ranges);
    const out = { rowCounts: {} };
    tables.forEach((t, idx) => {
      const cols = Object.keys(this.schema[t].cols);
      const types = this.schema[t].cols;
      const keyIdx = cols.indexOf(this.schema[t].key);
      const raw = results[idx] || [];
      out.rowCounts[t] = raw.length;
      out[t] = raw
        .filter((r) => r[keyIdx] !== undefined && r[keyIdx] !== '' && r[keyIdx] !== null)
        .map((r) => {
          const o = {};
          cols.forEach((c, j) => { o[c] = this.fromCell(types[c], r[j]); });
          return o;
        });
    });
    return out;
  }

  /**
   * Overwrites whole tables in the sheet with the given rows (one API call), then clears leftover rows.
   * @param tables {lists?: rows, chats?: rows, jobs?: rows}
   * @param rowCounts previous number of data rows per table (to know what to clear)
   */
  async writeTables(tables, rowCounts) {
    const data = [];
    const clears = [];
    for (const [t, rows] of Object.entries(tables)) {
      const def = this.schema[t];
      const cols = Object.keys(def.cols);
      const last = colLetter(cols.length);
      if (rows.length) {
        data.push({ range: `${def.sheet}!A2:${last}${rows.length + 1}`, values: rows.map((r) => cols.map((c) => this.toCell(def.cols[c], r[c]))) });
      }
      if ((rowCounts[t] || 0) > rows.length) clears.push(`${def.sheet}!A${rows.length + 2}:${last}${rowCounts[t] + 1}`);
      rowCounts[t] = rows.length;
    }
    if (data.length) await this.api.batchUpdate(data);
    if (clears.length) await this.api.batchClear(clears);
  }

  async appendLog(rows) {
    if (!rows.length) return;
    const def = this.schema.log;
    const cols = Object.keys(def.cols);
    await this.api.append(`${def.sheet}!A1`, rows.map((r) => cols.map((c) => this.toCell(def.cols[c], r[c]))));
  }
}

/**
 * Real Google Sheets API adapter (service account).
 * @param spreadsheetId  the bot's Google Sheet ID (from its URL)
 * @param keyFile        path to the service account JSON key
 */
function createGoogleApi(spreadsheetId, keyFile) {
  const { sheets, auth } = require('@googleapis/sheets');
  const client = sheets({
    version: 'v4',
    auth: new auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
  });
  const ss = client.spreadsheets;
  return {
    async getSpreadsheet() {
      const { data } = await ss.get({ spreadsheetId, fields: 'properties.timeZone,sheets.properties' });
      const map = {};
      (data.sheets || []).forEach((s) => { map[s.properties.title] = s.properties.sheetId; });
      return { timeZone: data.properties.timeZone, sheets: map };
    },
    async batchGet(ranges) {
      const { data } = await ss.values.batchGet({
        spreadsheetId, ranges, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS',
      });
      return (data.valueRanges || []).map((vr) => vr.values || []);
    },
    async batchUpdate(data) {
      await ss.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
    },
    async batchClear(ranges) {
      await ss.values.batchClear({ spreadsheetId, requestBody: { ranges } });
    },
    async formatCells(requests) {
      await ss.batchUpdate({ spreadsheetId, requestBody: { requests } });
    },
    async append(range, values) {
      await ss.values.append({ spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
    },
  };
}

module.exports = { SheetsStore, createGoogleApi, colLetter };
