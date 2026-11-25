'use strict';
/**
 * Entry point. Configuration via environment variables (see ../.env.example):
 *   BOT_TOKEN, ADMIN_IDS                       — same values as in Apps Script
 *   SPREADSHEET_ID                             — the bot's Google Sheet (from its URL)
 *   GOOGLE_APPLICATION_CREDENTIALS             — path to the service account JSON key
 *   DB_PATH        (default /data/bot.sqlite)  — SQLite file
 *   TELEGRAM_API_URL (default https://api.telegram.org)
 */
const path = require('path');
const fs = require('fs');
const { Db } = require('./db');
const { SheetsStore, createGoogleApi } = require('./sheets');
const { createTelegram } = require('./telegram');
const { Backend } = require('./backend');
const { loadCore, coreValue } = require('./core');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing environment variable ${name}`); process.exit(1); }
  return v;
}

async function main() {
  loadCore();
  const token = required('BOT_TOKEN');
  const adminIds = required('ADMIN_IDS');
  const spreadsheetId = required('SPREADSHEET_ID');
  const keyFile = required('GOOGLE_APPLICATION_CREDENTIALS');
  const dbPath = process.env.DB_PATH || '/data/bot.sqlite';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Db(dbPath, coreValue('SCHEMA'));
  const sheets = new SheetsStore(createGoogleApi(spreadsheetId, keyFile), {
    SCHEMA: coreValue('SCHEMA'), CONTROL_SHEET: coreValue('CONTROL_SHEET'), CONTROL_KEYS: coreValue('CONTROL_KEYS'),
  });
  const tg = createTelegram({ token, baseUrl: process.env.TELEGRAM_API_URL || undefined });
  const backend = new Backend({ db, sheets, tg, secrets: { BOT_TOKEN: token, ADMIN_IDS: adminIds } });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: flushing and exiting`);
    await backend.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await backend.start();
}

main().catch((e) => { console.error(e); process.exit(1); });
