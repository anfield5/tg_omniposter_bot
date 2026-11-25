'use strict';
/** Minimal Bot API client on top of built-in fetch. Never throws: returns {ok:false, ...} on errors. */

function createTelegram({ token, baseUrl = 'https://api.telegram.org', fetchImpl = globalThis.fetch }) {
  async function call(method, payload = {}, { timeoutMs = 30000, signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch (e) {
        return { ok: false, error_code: res.status, description: 'Bad response: ' + text.slice(0, 200) };
      }
    } catch (e) {
      return { ok: false, error_code: 0, description: (e.name === 'AbortError' || e.name === 'TimeoutError' ? 'Aborted: ' : 'Network: ') + e.message };
    }
  }

  async function batch(calls) {
    return Promise.all(calls.map((c) => call(c.method, c.payload)));
  }

  return { call, batch };
}

module.exports = { createTelegram };
