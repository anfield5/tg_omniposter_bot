'use strict';
/**
 * Builds the Apps Script bundle: dist/apps-script = core/*.js + apps-script/*.gs + appsscript.json.
 * clasp pushes this folder (rootDir in .clasp.json), so Apps Script runs the same core as the server.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'apps-script');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (dir, filter) => fs.readdirSync(path.join(root, dir)).filter(filter).forEach((f) => {
  fs.copyFileSync(path.join(root, dir, f), path.join(out, f));
});
copy('core', (f) => f.endsWith('.js'));
copy('apps-script', (f) => f.endsWith('.gs') || f === 'appsscript.json');
console.log('Built ' + path.relative(root, out) + ': ' + fs.readdirSync(out).join(', '));
