'use strict';
/**
 * Server backend: runs the shared core with SQLite storage and a Google Sheets mirror.
 *
 *  ┌ controlLoop  every 15 s: read Control sheet, write heartbeat (= lease renewal),
 *  │              activate / deactivate according to active_backend
 *  ├ pollLoop     when active: long-poll getUpdates → handle commands one by one
 *  └ schedLoop    when active: run the scheduler every few seconds
 *
 * All work that touches data goes through one serial queue, so the core never runs concurrently
 * (the server equivalent of the Apps Script lock). After each operation SQLite changes are flushed
 * to the sheet; before each post is sent the advanced schedule is flushed too (checkpoint effect),
 * so a failover to Apps Script never re-sends a post.
 */
const { DateTime } = require('luxon');
const { loadCore, coreValue } = require('./core');

class Backend {
  /**
   * @param deps.db       Db (SQLite)
   * @param deps.sheets   SheetsStore
   * @param deps.tg       Telegram client {call, batch}
   * @param deps.secrets  {BOT_TOKEN, ADMIN_IDS}
   */
  constructor({ db, sheets, tg, secrets, logger = console, timings = {}, sleep }) {
    loadCore();
    this.CFG = coreValue('CFG');
    this.VERSION = coreValue('VERSION');
    this.db = db;
    this.sheets = sheets;
    this.tg = tg;
    this.secrets = secrets;
    this.logger = logger;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timings = Object.assign({
      controlEveryMs: this.CFG.HEARTBEAT_MS,
      schedEveryMs: 5000,
      pollTimeoutS: 25,
      idleMs: 1000,
    }, timings);

    this.active = false;
    this.leaseUntil = 0;
    this.rowCounts = {};
    this.currentUpdateId = null;
    this.pollAbort = null;
    this.stopped = false;
    this.q = Promise.resolve();
    globalThis.PLATFORM = this.platform();
  }

  // ------------------------------- PLATFORM -------------------------------

  platform() {
    const self = this;
    const zone = () => self.sheets.tz;
    return {
      name: 'server',
      earlyToleranceMs: 0, // the scheduler runs every few seconds — no need to post early
      tzName: zone,
      tzParse(s, fmt) { const dt = DateTime.fromFormat(s, fmt, { zone: zone() }); return dt.isValid ? dt.toMillis() : null; },
      tzFormat(ms, fmt) { return DateTime.fromMillis(Number(ms), { zone: zone() }).toFormat(fmt); },
      getProp: (k) => self.db.getKv(k),
      setProp: (k, v) => self.db.setKv(k, v),
      secret: (k) => self.secrets[k],
      lock: () => true,   // the serial queue already guarantees exclusive access
      unlock: () => {},
      log: (level, msg) => (level === 'error' ? self.logger.error : self.logger.log).call(self.logger, msg),
      db: {
        all: (t) => self.db.all(t),
        insert: (t, rows) => self.db.insert(t, rows),
        update: (t, row) => self.db.update(t, row),
        remove: (t, rows) => self.db.remove(t, rows),
      },
    };
  }

  // -------------------------------- Driver --------------------------------

  /** Runs a core generator to completion, executing its effects asynchronously. */
  async run(gen) {
    let r = gen.next();
    while (!r.done) {
      let res, err = null;
      try { res = await this.effect(r.value); } catch (e) { err = e; }
      r = err ? gen.throw(err) : gen.next(res);
    }
    return r.value;
  }

  async effect(eff) {
    switch (eff.t) {
      case 'tg': return this.tg.call(eff.method, eff.payload);
      case 'batch': return this.tg.batch(eff.calls);
      case 'sleep': return this.sleep(eff.ms);
      case 'checkpoint': return this.checkpoint();
      case 'getControl': return this.sheets.readControl();
      case 'handover': return this.handover(eff.to, eff.by);
      default: throw new Error('Unknown effect: ' + eff.t);
    }
  }

  /** Serial queue: every operation on data runs alone. */
  enqueue(fn) {
    const p = this.q.then(fn);
    this.q = p.catch((e) => this.logger.error('queue: ' + (e && e.stack)));
    return p;
  }

  // ------------------------------- Mirroring -------------------------------

  /** Copies changed tables and new log rows from SQLite to the sheet. */
  async flush() {
    const dirty = [...this.db.dirty];
    this.db.dirty.clear();
    try {
      if (dirty.length) {
        const tables = {};
        dirty.forEach((t) => { tables[t] = this.db.all(t); });
        await this.sheets.writeTables(tables, this.rowCounts);
      }
      for (;;) {
        const logs = this.db.unmirroredLog(500);
        if (!logs.length) break;
        await this.sheets.appendLog(logs);
        this.db.markMirrored(logs.map((l) => l._id));
        if (logs.length < 500) break;
      }
    } catch (e) {
      dirty.forEach((t) => this.db.dirty.add(t));
      throw e;
    }
  }

  /** Before sending a post: make sure the advanced schedule is in the sheet (failover safety). */
  async checkpoint() {
    try { await this.flush(); } catch (e) {
      this.logger.error('checkpoint flush failed, retrying: ' + e.message);
      await this.sleep(1000);
      try { await this.flush(); } catch (e2) { this.logger.error('checkpoint flush failed again, sending anyway: ' + e2.message); }
    }
  }

  // ---------------------------- Activation / handover ----------------------------

  async controlTick() {
    let ctl = null;
    try {
      ctl = await this.sheets.readControl();
      await this.sheets.writeControl({ server_heartbeat: Date.now(), server_version: this.VERSION });
      this.leaseUntil = Date.now() + this.CFG.LEASE_MS;
    } catch (e) {
      this.logger.error('control: ' + e.message);
    }
    if (this.active && Date.now() > this.leaseUntil) {
      await this.enqueue(() => this.deactivate('no connection to Google Sheets for ' + Math.round(this.CFG.LEASE_MS / 60000) + ' min', true)).catch(() => {});
      return;
    }
    if (!ctl) return;
    const wantActive = globalThis.activeBackend_(ctl) === 'server';
    if (wantActive && !this.active) await this.enqueue(() => this.activate(ctl)).catch(() => {});
    else if (!wantActive && this.active) await this.enqueue(() => this.deactivate('the Control sheet now says "' + ctl.active_backend + '"', true)).catch(() => {});
    else if (this.active && this.db.dirty.size) await this.enqueue(() => this.flush()).catch(() => {});
  }

  /** Take over: the sheet is the source of truth while the server was passive → import it into SQLite. */
  async activate(ctl) {
    if (this.active) return;
    await this.sheets.ensureTimeFormats().catch((e) => this.logger.error('formats: ' + e.message));
    const data = await this.sheets.importTables();
    this.db.replaceAll(data);
    this.rowCounts = data.rowCounts;
    globalThis.invalidateSchedule_();
    await this.tg.call('deleteWebhook', { drop_pending_updates: false });
    this.active = true;
    this.pollAbort = new AbortController();
    this.logger.log(`activated (epoch ${ctl.epoch})`);
    await this.run(globalThis.notifyAdminsE_(`✅ <b>Server</b> is now handling the bot (v${this.VERSION}).\n` +
      `Imported: ${data.lists.length} lists, ${data.chats.length} chats, ${data.jobs.length} jobs.`));
  }

  async deactivate(reason, notify) {
    if (!this.active) return;
    this.active = false;
    if (this.pollAbort) this.pollAbort.abort();
    this.logger.log('deactivated: ' + reason);
    await this.flush().catch((e) => this.logger.error('flush on deactivate: ' + e.message));
    if (notify) await this.run(globalThis.notifyAdminsE_('⏸ The server stopped handling the bot: ' + reason));
  }

  /** /switch gas, executed by the server while it handles that very command. */
  async handover(to, by) {
    if (to !== 'gas') throw new Error('The server can only hand over to Apps Script');
    const ctl = await this.sheets.readControl();
    await this.flush();                 // 1. the sheet gets every change (throws → switch aborted, server stays active)
    this.active = false;                // 2. no more scheduling / updates here
    if (this.pollAbort) this.pollAbort.abort();
    if (this.currentUpdateId != null) { // 3. confirm the /switch update so Telegram doesn't re-deliver it to Apps Script
      await this.tg.call('getUpdates', { offset: this.currentUpdateId + 1, timeout: 0, limit: 1 });
    }
    await this.sheets.writeControl({ active_backend: 'gas', epoch: (ctl.epoch || 0) + 1, switched_at: Date.now(), switched_by: by });
    const r = await this.tg.call('setWebhook', { url: ctl.gas_webhook_url, allowed_updates: this.CFG.ALLOWED_UPDATES, max_connections: 1 });
    return r.ok ? '✅ Server released the bot.' : '⚠️ Server released the bot, but setWebhook failed (' + r.description + '). Apps Script will retry on its next run.';
  }

  // --------------------------------- Loops ---------------------------------

  async pollOnce() {
    if (!this.active) return false;
    const offset = Number(this.db.getKv('POLL_OFFSET') || 0) || undefined;
    const r = await this.tg.call('getUpdates',
      { offset, timeout: this.timings.pollTimeoutS, allowed_updates: this.CFG.ALLOWED_UPDATES },
      { timeoutMs: (this.timings.pollTimeoutS + 10) * 1000, signal: this.pollAbort && this.pollAbort.signal });
    if (!this.active) return false;
    if (!r.ok) {
      if (r.error_code === 409) this.logger.error('getUpdates conflict: a webhook is set elsewhere');
      await this.sleep(r.error_code === 409 ? 5000 : 2000);
      return false;
    }
    for (const u of r.result) {
      await this.enqueue(async () => {
        if (!this.active) return; // switched away mid-batch: leave the rest unconfirmed for Apps Script
        this.currentUpdateId = u.update_id;
        try { await this.run(globalThis.handleUpdateE_(u)); } catch (e) { this.logger.error('update: ' + (e && e.stack)); }
        this.db.setKv('POLL_OFFSET', u.update_id + 1);
        this.currentUpdateId = null;
        await this.flush().catch((e) => this.logger.error('flush: ' + e.message));
      }).catch(() => {});
    }
    return true;
  }

  async schedOnce() {
    if (!this.active) return;
    await this.enqueue(async () => {
      if (!this.active) return;
      await this.run(globalThis.runSchedulerE_());
      await this.flush().catch((e) => this.logger.error('flush: ' + e.message));
    }).catch(() => {});
  }

  async loop(fn, everyMs) {
    while (!this.stopped) {
      try { await fn(); } catch (e) { this.logger.error(e && e.stack); }
      if (everyMs) await this.sleep(everyMs);
    }
  }

  async start() {
    await this.sheets.init();
    this.logger.log(`tg-post-bot server v${this.VERSION}, time zone ${this.sheets.tz}`);
    this.loops = [
      this.loop(() => this.controlTick(), this.timings.controlEveryMs),
      this.loop(() => this.schedOnce(), this.timings.schedEveryMs),
      this.loop(async () => { if (!(await this.pollOnce())) await this.sleep(this.timings.idleMs); }, 0),
    ];
  }

  async stop() {
    this.stopped = true;
    if (this.pollAbort) this.pollAbort.abort();
    await this.enqueue(() => (this.active ? this.flush() : null)).catch((e) => this.logger.error('final flush: ' + e.message));
  }
}

module.exports = { Backend };
