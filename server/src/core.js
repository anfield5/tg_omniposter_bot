'use strict';
/**
 * Loads the shared core (../../core/*.js) into the global scope — exactly like Apps Script does —
 * so the server and Apps Script run the very same code.
 * globalThis.PLATFORM must be set before any core function is called.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_DIR = process.env.CORE_DIR || path.resolve(__dirname, '..', '..', 'core');
let loaded = false;

function loadCore() {
  if (loaded) return;
  fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort().forEach((f) => {
    const file = path.join(CORE_DIR, f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  });
  loaded = true;
}

/** Access to core top-level constants (const/class are not properties of globalThis). */
function coreValue(name) { return vm.runInThisContext(name); }

module.exports = { loadCore, coreValue };
