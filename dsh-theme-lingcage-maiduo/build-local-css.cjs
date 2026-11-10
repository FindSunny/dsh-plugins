// 生成本地私有主题 theme.local.css（不进仓库）：
//   - 用 assets/background.local.jpg 作背景（个人壁纸）
//   - 替换模板里标记为 __BG_BLOCK_* 的 body::before 块（照片需要更厚的压暗 + 轻微模糊）
//   - 追加 theme.local.extra.css（从照片取色的令牌覆盖）
//
//   node build-local-css.cjs
//
// 没有背景图时直接跳过，插件会退回仓库里的 theme.css（原创 SVG 版）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const photoPath = path.join(here, 'assets', 'background.local.jpg');
const templatePath = path.join(here, 'theme.template.css');
const extraPath = path.join(here, 'theme.local.extra.css');
const outPath = path.join(here, 'theme.local.css');

if (!fs.existsSync(photoPath)) {
  console.log('skip: assets/background.local.jpg 不存在（本地私有主题不生成）');
  process.exit(0);
}

const photo = fs.readFileSync(photoPath);
const uri = `data:image/jpeg;base64,${photo.toString('base64')}`;

const block = `/* __BG_BLOCK_START__ */
/* 侧栏宽度：桌面版侧栏约 248px；收起成 rail 时把它调小或设 0 即可 */
:root {
  --dsh-maiduo-strip: 248px;
  /* 视频不透明度：0.25 很淡，0.42 清楚，0.6 很重。数值越大越会"染色"其下的代码块 */
  --dsh-maiduo-video-opacity: 0.42;
}

/* 左侧一列：她的静帧人像（视频只铺右侧，不压在这里） */
body::after {
  content: "" !important;
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  width: var(--dsh-maiduo-strip) !important;
  height: 100% !important;
  z-index: -2 !important;
  pointer-events: none !important;
  background: url("__BG_DATA_URI__") center top / cover no-repeat !important;
  filter: saturate(0.92) brightness(0.80) !important;
}

/* 压暗层：左侧轻微、右侧留给视频但仍压住正文 */
body::before {
  content: "" !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: -1 !important;
  pointer-events: none !important;
  background: linear-gradient(
    to right,
    rgba(8, 6, 5, 0.28) 0,
    rgba(8, 6, 5, 0.28) var(--dsh-maiduo-strip),
    rgba(8, 6, 5, 0.52) calc(var(--dsh-maiduo-strip) + 48px),
    rgba(8, 6, 5, 0.66) 100%
  ) !important;
}
/* __BG_BLOCK_END__ */`;

const start = '/* __BG_BLOCK_START__ */';
const end = '/* __BG_BLOCK_END__ */';
const template = fs.readFileSync(templatePath, 'utf8');
const from = template.indexOf(start);
const to = template.indexOf(end);
if (from < 0 || to < 0) throw new Error('template has no __BG_BLOCK_START__/__BG_BLOCK_END__ markers');

const before = template.slice(0, from);
const after = template.slice(to + end.length);
let css = `${before}${block}${after}`.replace('__BG_DATA_URI__', uri);

if (fs.existsSync(extraPath)) css += `\n\n/* ---- theme.local.extra.css ---- */\n${fs.readFileSync(extraPath, 'utf8')}`;

fs.writeFileSync(outPath, css);
console.log(`theme.local.css written: ${css.length} bytes (photo ${photo.length} -> ${uri.length})`);
