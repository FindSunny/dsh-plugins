// 生成并（可选）校验插件市场索引 index.json（format 1）。
//
//   node market/build-index.cjs
//
// 校验器优先用 @deepseek-ai/dsh-plugin-market-index（DSH 自己拉索引时用的就是它）：
//   - 若仓库里装了这个包（pnpm add -D @deepseek-ai/dsh-plugin-market-index），自动使用；
//   - 也可以用环境变量指定一个实现：DSH_MARKET_VALIDATOR=<path-to/lib/index.js>；
//   - 都没有则只生成、不校验，并打印提示。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ← 改成你的 GitHub 用户名（仓库名如要改也改这里）
const OWNER = 'FindSunny';
const REPO = 'dsh-plugins';
const BASE = `https://github.com/${OWNER}/${REPO}`;
const INDEX_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/market/index.json`;

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'market', 'index.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const previous = fs.existsSync(OUTPUT) ? readJson(OUTPUT) : undefined;
const nowSeconds = Math.floor(Date.now() / 1000);

/** 已列过的版本沿用原来的发布时间，避免每次生成都改一个数。 */
function publishTimestamp(name, version) {
  const found = previous?.plugins?.find((plugin) => plugin.name === name)?.versions?.find((item) => item.version === version);
  return found?.publishTimestamp ?? nowSeconds;
}

const notifyPkg = readJson(path.join(ROOT, 'dsh-notify', 'package.json'));
const themePkg = readJson(path.join(ROOT, 'dsh-theme-mao', 'package.json'));
const notifyIcon = fs.readFileSync(path.join(ROOT, 'dsh-notify', 'icon.png'));

const index = {
  format: 1,
  title: { en: "SUO's DSH Plugins", zh: '索剑飞的 DSH 插件' },
  description: {
    en: 'Hand-made DeepSeek Harness plugins: Windows desktop notifications and a theme.',
    zh: '自己做的 DSH 插件：Windows 桌面通知、主题。',
  },
  metadata: {
    categories: {
      notify: { title: { en: 'Notifications', zh: '通知' } },
      theme: { title: { en: 'Themes', zh: '主题' } },
    },
    labels: {
      windows: { title: { en: 'Windows', zh: 'Windows' } },
    },
  },
  plugins: [
    {
      name: notifyPkg.name,
      title: { en: 'Desktop Notifications', zh: '桌面通知' },
      description: {
        en: 'Windows toast when a long turn finishes: answer summary, elapsed time, completion reason, and a click that focuses DSH.',
        zh: '长任务答完弹 Windows 通知：带回答摘要、用时，区分答完/中断/出错，点一下唤回 DSH。',
      },
      // 图标内联（解码后 ≤ 32 KiB），省得再托管图片
      icon: `data:image/png;base64,${notifyIcon.toString('base64')}`,
      author: 'Suo Jianfei',
      homepage: `${BASE}/tree/main/dsh-notify`,
      repository: { url: BASE, directory: 'dsh-notify' },
      metadata: {
        category: 'notify',
        keywords: ['notification', 'toast', 'windows', 'turn', 'desktop'],
        labels: ['windows'],
      },
      versions: [
        {
          version: notifyPkg.version,
          publishTimestamp: publishTimestamp(notifyPkg.name, notifyPkg.version),
          // git 通道：commit 必须是 40 位小写 SHA，path 是仓库里的子目录
          source: { type: 'git', url: BASE, commit: process.env.DSH_MARKET_COMMIT ?? '0'.repeat(40), path: 'dsh-notify' },
        },
      ],
    },
    {
      name: themePkg.name,
      title: { en: 'People, People (Mao theme)', zh: '人民万岁主题' },
      description: {
        en: 'Photo background and a clean light palette for DeepSeek Harness.',
        zh: '给 DeepSeek Harness 换一张老照片背景 + 干净浅色调。',
      },
      author: 'Suo Jianfei',
      homepage: `${BASE}/tree/main/dsh-theme-mao`,
      repository: { url: BASE, directory: 'dsh-theme-mao' },
      metadata: {
        category: 'theme',
        keywords: ['theme', 'skin', 'background'],
      },
      versions: [
        {
          version: themePkg.version,
          publishTimestamp: publishTimestamp(themePkg.name, themePkg.version),
          source: { type: 'git', url: BASE, commit: process.env.DSH_MARKET_COMMIT ?? '0'.repeat(40), path: 'dsh-theme-mao' },
        },
      ],
    },
  ],
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(index, null, 2)}\n`);
console.log(`written ${path.relative(ROOT, OUTPUT)} (${fs.statSync(OUTPUT).size} bytes)`);

// ---- 用 DSH 自己的校验器过一遍 --------------------------------------------
if (typeof URL.canParse !== 'function') {
  // 老 node 没有 URL.canParse，校验器依赖它
  URL.canParse = (value, base) => {
    try {
      new URL(value, base);
      return true;
    } catch {
      return false;
    }
  };
}

async function loadValidator() {
  const candidates = [];
  if (process.env.DSH_MARKET_VALIDATOR) candidates.push(process.env.DSH_MARKET_VALIDATOR);
  candidates.push('@deepseek-ai/dsh-plugin-market-index');
  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith('.') || candidate.includes(':') ? require('node:url').pathToFileURL(candidate).href : candidate;
      return await import(specifier);
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

(async () => {
  const validator = await loadValidator();
  if (!validator) {
    console.log('SKIP validation — install @deepseek-ai/dsh-plugin-market-index (or set DSH_MARKET_VALIDATOR) to verify.');
    return;
  }
  const { parseMarketIndex, marketInstallTarget } = validator;
  const parsed = parseMarketIndex(readJson(OUTPUT), INDEX_URL);
  console.log(`VALID format 1 — ${parsed.plugins.length} plugins`);
  for (const plugin of parsed.plugins) {
    const version = plugin.versions[0];
    console.log(`  ${plugin.name}@${version.version} -> ${marketInstallTarget(plugin.name, version).spec}`);
  }
  if (process.env.DSH_MARKET_COMMIT === undefined) {
    console.log('NOTE commit is all zeros — set DSH_MARKET_COMMIT=<40-hex sha> before publishing.');
  }
})().catch((error) => {
  console.error('INVALID:', error.message);
  process.exit(1);
});
