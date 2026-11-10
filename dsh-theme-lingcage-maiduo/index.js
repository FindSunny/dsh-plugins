'use strict';
// 灵笼 · 麦朵「霜与余烬」theme host plugin (row-based injection).
//
// DSH has two index renderers that share one structured injection table:
//   - browser (dsh web):        webServer.renderIndex() renders rows, then tapIndex transforms;
//   - desktop (Electron shell): the window loads dsh-app://app/ and applies the rows the host
//                               sends at boot (`DESKTOP_IPC.boot` → frontend applies injections).
// A raw `tapIndex` transform is therefore invisible in the desktop app, so this plugin
// contributes typed rows instead (`style` + optionally `script-src`) — they render in both.
//
// 本地私有素材（不进仓库，存在才生效）：
//   assets/background.local.jpg  侧栏人像（由 build-local-css.cjs 内联进 theme.local.css）
//   assets/background.local.mp4  右侧工作区的循环背景视频（经 /theme-maiduo/bg.mp4 路由提供）
//
// 改样式：编辑 theme.template.css / theme.local.extra.css / assets/background.svg，
//         然后 `node build-css.cjs` 和 `node build-local-css.cjs`。

const { appendFileSync, createReadStream, existsSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const CSS_PATH = join(__dirname, 'theme.css');
// 本地私有主题（个人壁纸 + 视频）：存在时优先于仓库里的原创版
const LOCAL_CSS_PATH = join(__dirname, 'theme.local.css');
// 优先用 ffmpeg 生成的"首尾交叉溶解"无缝版；没有就退回原始素材
const LOOP_VIDEO_PATH = join(__dirname, 'assets', 'background.loop.mp4');
const RAW_VIDEO_PATH = join(__dirname, 'assets', 'background.local.mp4');
const VIDEO_PATH = existsSync(LOOP_VIDEO_PATH) ? LOOP_VIDEO_PATH : RAW_VIDEO_PATH;
const BOOT_JS_PATH = join(__dirname, 'boot.js');
const DIAG_PATH = join(__dirname, 'media-routes.log');

// 路径带版本号：换素材/改逻辑时 bump 一下，避免旧路由闭包或浏览器缓存拿到旧内容
const VIDEO_ROUTE = '/theme-maiduo/v2/bg.mp4';
const ACK_ROUTE = '/theme-maiduo/v2/ack';

/** 自检日志（本地文件，不进仓库）：排查"路由到底注册上没有"。 */
function note(message) {
  try {
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* 只是诊断，写不了就算了 */
  }
}

let cached = null;

function loadCss() {
  for (const file of [LOCAL_CSS_PATH, CSS_PATH]) {
    try {
      const css = readFileSync(file, 'utf8');
      if (css.trim() !== '') {
        cached = css;
        return cached;
      }
    } catch {
      // 没有这个文件就试下一个；都失败时保留上一份可用样式
    }
  }
  return cached;
}

loadCss();

function pushThemeStyle(table) {
  const css = loadCss();
  if (css === null || css.trim() === '') return;
  table.push({ kind: 'style', text: css });
}

/**
 * 视频元素的标记：先作为 html 行插入（不依赖脚本），再由 boot.js 接管播放。
 * 素材是**横屏 1920×1080**（ffmpeg 实测），构图上人物在右半边、她伸手的"手"在中偏左，
 * 左边是樱花。遮罩按**像素**（只挡靠近侧栏的 ~200px）—— 之前按百分比算，窄窗口下 cover
 * 只留画面最右一条，她正好被那前 26% 的透明区吃掉，于是"只有大窗口才看得到"。
 * 放在最上层、低透明度、不吃点击（放负 z-index 会被正文面板整个盖住，实测）。
 */
const VIDEO_HTML =
  '<video data-dsh-maiduo autoplay muted loop playsinline preload="auto" aria-hidden="true" src="' +
  VIDEO_ROUTE +
  // ⚠️ <video> 是替换元素：只给四边定位、不写宽高时，浏览器按**固有尺寸**排版（实测 1920×1080），
  // right/bottom 被忽略 → 元素比窗口还宽，窗口一窄就只剩画面左侧、人被挤到窗口外。
  // 所以必须显式给出 width/height。
  '" style="position:fixed;top:0;height:100vh;left:var(--dsh-maiduo-strip,248px);' +
  'width:calc(100vw - var(--dsh-maiduo-strip,248px));' +
  // 锚点定在她身上（画面 62% 处）：窗口变窄只会裁掉两侧樱花，人始终在画面里
  'object-fit:cover;object-position:62% center;z-index:2147483000;pointer-events:none;' +
  'opacity:var(--dsh-maiduo-video-opacity,.32);' +
  '-webkit-mask-image:linear-gradient(to right,rgba(0,0,0,0) 0px,rgba(0,0,0,.3) 20px,' +
  'rgba(0,0,0,.72) 60px,rgba(0,0,0,.9) 110px,rgba(0,0,0,.95) 100%);' +
  'mask-image:linear-gradient(to right,rgba(0,0,0,0) 0px,rgba(0,0,0,.3) 20px,' +
  'rgba(0,0,0,.72) 60px,rgba(0,0,0,.9) 110px,rgba(0,0,0,.95) 100%);' +
  'filter:saturate(.95)"></video>';

/**
 * 循环背景视频的播放入口。两个都注入：
 *   - html 行：不依赖 JS 就能把 <video> 放进 DOM；
 *   - 内联 script 行：强制 muted / play()、失败重试，并回发一条诊断回执。
 * 两者都不发网络请求，也都不会被 boot await，因此不会拖垮启动。
 */
function pushVideoBoot(table) {
  if (!existsSync(VIDEO_PATH)) return;
  table.push({ kind: 'html', placement: 'body', html: VIDEO_HTML });
  let code = '';
  try {
    code = readFileSync(BOOT_JS_PATH, 'utf8');
  } catch {
    return;
  }
  if (code.trim() === '') return;
  // 把路由路径注入给脚本：两边的常量同源，换版本号时不会有一边打 404
  const prelude = `window.__dshMaiduoPaths=${JSON.stringify({ video: VIDEO_ROUTE, ack: ACK_ROUTE })};`;
  table.push({ kind: 'script', placement: 'body', text: prelude + code });
}

/** 本地私有版：运行时量出侧栏真实宽度写给 --dsh-maiduo-strip（否则人像条右边露出底色）。 */
const FIT_SIDEBAR_PATH = join(__dirname, 'fit-sidebar.js');

function pushSidebarFit(table) {
  if (!existsSync(FIT_SIDEBAR_PATH)) return;
  let code = '';
  try {
    code = readFileSync(FIT_SIDEBAR_PATH, 'utf8');
  } catch {
    return;
  }
  if (code.trim() === '') return;
  table.push({ kind: 'script', placement: 'body', text: code });
}

function sendFile(file, contentType, req, res) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  const total = stat.size;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/u.exec(range.trim()) : null;
  if (match !== null) {
    let start = match[1] === '' ? undefined : Number(match[1]);
    let end = match[2] === '' ? undefined : Number(match[2]);
    if (start === undefined && end !== undefined) {
      start = Math.max(0, total - end);
      end = total - 1;
    }
    if (start === undefined) start = 0;
    if (end === undefined || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(total));
  createReadStream(file).pipe(res);
}

/**
 * 注册媒体路由。
 * 状态放 globalThis（跨模块实例共享），逐条 try/catch，duplicate 视为成功 —— 否则一条冲突
 * 就会让后面的路由全部落空。持有的 disposer 在插件卸载时统一释放，保证重载后路由闭包是新代码
 * （否则会一直用旧闭包里的旧文件路径）。
 */
const REGISTRY = (globalThis.__dshMaiduoRoutes ??= { paths: {}, disposers: {} });
if (!REGISTRY.paths) REGISTRY.paths = {};
if (!REGISTRY.disposers) REGISTRY.disposers = {};

/** 每次请求都重新解析文件：这样换成循环版后不必重建路由。 */
function currentVideoPath() {
  return existsSync(LOOP_VIDEO_PATH) ? LOOP_VIDEO_PATH : RAW_VIDEO_PATH;
}

function registerMediaRoutes(ctx) {
  let server;
  try {
    server = ctx.get('webServer');
  } catch (error) {
    note(`webServer lookup threw: ${error && error.message ? error.message : error}`);
    return;
  }
  if (!server || typeof server.register !== 'function') {
    note('webServer not ready yet');
    return;
  }

  // 以**路径**为键：路由路径带版本号，换素材时自然注册新路径，不会被旧标记挡住
  const install = (route) => {
    if (REGISTRY.paths[route.path]) return;
    try {
      const dispose = server.register(route);
      REGISTRY.paths[route.path] = true;
      if (typeof dispose === 'function') REGISTRY.disposers[route.path] = dispose;
      note(`route registered: ${route.path}`);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (message.includes('duplicate')) {
        REGISTRY.paths[route.path] = true;
        note(`route already present: ${route.path}`);
        return;
      }
      note(`route failed ${route.path}: ${message}`);
    }
  };

  if (existsSync(currentVideoPath())) {
    install({
      kind: 'exact',
      path: VIDEO_ROUTE,
      handler: (req, res) => {
        note(`video ${req.method} range=${req.headers.range ?? '-'}`);
        sendFile(currentVideoPath(), 'video/mp4', req, res);
      },
    });
    install({
      kind: 'prefix',
      path: ACK_ROUTE,
      handler: (req, res) => {
        note(`ack ${req.url}`);
        res.statusCode = 204;
        res.end();
      },
    });
  } else {
    note('video missing, no route');
  }
}

module.exports = {
  name: 'dsh-theme-lingcage-maiduo',
  apply(ctx) {
    note('apply');
    // `webserver/index-inject` is emitted by the host that owns the table, so by the time it
    // fires the webServer definitely exists — that is the reliable moment to register routes.
    ctx.on('webserver/index-inject', (table) => {
      registerMediaRoutes(ctx);
      if (!Array.isArray(table)) return;
      pushThemeStyle(table);
      pushVideoBoot(table);
      // 只有本地私有版才需要量侧栏（公开版是整屏 SVG，没有侧栏人像条）
      if (existsSync(LOCAL_CSS_PATH)) pushSidebarFit(table);
    });
    // Try early too; the call above retries if the service was not mounted yet.
    registerMediaRoutes(ctx);

    // 卸载时释放本实例注册的路由：否则重载后仍是旧闭包（旧文件路径 / 旧素材）
    ctx.effect(() => () => {
      for (const path of Object.keys(REGISTRY.disposers)) {
        try {
          REGISTRY.disposers[path]();
        } catch {
          /* 已经不在了 */
        }
        delete REGISTRY.disposers[path];
        delete REGISTRY.paths[path];
      }
    });
  },
};
