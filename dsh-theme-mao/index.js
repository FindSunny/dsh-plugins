'use strict';
// 人民万岁 theme host plugin (row-based injection).
//
// DSH has two index renderers that share one structured injection table:
//   - browser (dsh web):        webServer.renderIndex() renders rows, then tapIndex transforms;
//   - desktop (Electron shell): the window loads dsh-app://app/ from the dist folder and
//                               applies ONLY the rows the host sends over IPC at startup.
// A raw `tapIndex` transform is therefore invisible in the desktop app, so this plugin
// contributes a typed `{ kind: 'style' }` row instead — it renders in both.
//
// theme.css is re-read on every injection pass, so style tweaks take effect on the next
// page load (browser: every index request; desktop: every app launch).

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const CSS_PATH = join(__dirname, 'theme.css');

let cached = null;

function loadCss() {
  try {
    cached = readFileSync(CSS_PATH, 'utf8');
  } catch {
    // keep the last good copy; a broken file must not break the boot table
  }
  return cached;
}

loadCss();

function pushThemeStyle(table) {
  const css = loadCss();
  if (css === null || css.trim() === '') return;
  table.push({ kind: 'style', text: css });
}

module.exports = {
  name: 'dsh-theme-mao',
  apply(ctx) {
    // No webServer injection needed: `webserver/index-inject` is emitted by the host that
    // owns the table, and subscribing is enough on both paths.
    ctx.on('webserver/index-inject', (table) => {
      if (Array.isArray(table)) pushThemeStyle(table);
    });
  },
};
