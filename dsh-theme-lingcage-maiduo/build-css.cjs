// 把 assets/background.svg 内联成 data URI，替换 theme.template.css 的 __BG_DATA_URI__，
// 产出插件实际读取的 theme.css。
//
//   node build-css.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const svg = fs.readFileSync(path.join(here, 'assets', 'background.svg'), 'utf8');
const template = fs.readFileSync(path.join(here, 'theme.template.css'), 'utf8');

const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
const css = template.replace('__BG_DATA_URI__', dataUri);
if (css === template) throw new Error('template has no __BG_DATA_URI__ placeholder');

const out = path.join(here, 'theme.css');
fs.writeFileSync(out, css);
console.log(`theme.css written: ${css.length} bytes (svg ${svg.length} -> ${dataUri.length})`);
