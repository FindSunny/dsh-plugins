/**
 * dsh-notify — Windows 桌面通知：一段 turn 结束后，若耗时超过阈值就弹通知。
 *
 * 事件来源：`session/event`（post-commit 追加流）里的 `turn/start` / `turn/end`。
 *   - `turn/end` 的 `data.reason.kind` ∈ completed | aborted | blocked | error |
 *     max-tokens | interrupted | forked，正好区分「答完 / 中断 / 出错」。
 *   - `turn/end` 不带耗时，所以用 `turn/start` 的观测时刻自己算（内存 Map；
 *     插件装好之前就开着的 turn 用会话日志里同 turn 的 turn/start.time 兜底）。
 *
 * 通知通道：宿主是 `ELECTRON_RUN_AS_NODE=1` 的普通 Node 进程（dsh-desktop-host），
 * `electron.Notification` 不可用，因此 spawn 一次性 `powershell.exe`：
 *   1. 默认 WinRT 吐司，AUMID 用 DSH 真实注册过的 `com.deepseek.dsh`
 *      （来自开始菜单快捷方式 DeepSeek Harness.lnk；写 `"DSH"` 这种未注册 AppID，
 *      Windows 会收下通知、塞进通知中心，但**不弹横幅**——本机实测）。
 *      声音走 XML `<audio>`（PS 5.1 里 ToastAudio 不可用）。
 *   2. 退出码非 0 时降级为托盘气泡（NotifyIcon，纯 Win32，不需要 AUMID 注册；
 *      必须边 DoEvents 泵消息边等，否则气泡不渲染）。
 *   `stdio: 'ignore'`（本机沙箱下管道捕获会 EPERM）；进程干完即退，无常驻、无僵尸。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-notify';

/** 吐司左侧的图标（就是插件列表里那张）；Windows 侧不认我们包的图标，得用 appLogoOverride 显式带上。 */
const ICON_FILE = fileURLToPath(new URL('./icon.png', import.meta.url));

/** 本插件在 profile patch 里的行 id，同时也是设置的 namespace。 */
const ROW_ID = 'dsh-notify';
/** 上一次通知的落地记录，排查「为什么没弹」时看这里。 */
const DIAGNOSTIC_PATH = join(homedir(), '.dsh', 'dsh-notify-last.json');

const DEFAULTS = {
  enabled: true,
  thresholdSeconds: 60,
  summaryChars: 90,
  channel: 'toast',
  sound: true,
  showIcon: true,
  notifyOnError: true,
  notifyOnAborted: false,
  notifySubagents: false,
  // 关键：必须用 DSH 真实注册过的 AUMID（开始菜单快捷方式 DeepSeek Harness.lnk 里写的），
  // 不能用 `"DSH"` —— 那个 Windows 不认识，通知会“收下但不弹横幅”。
  appId: 'com.deepseek.dsh',
  debug: false,
};

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('总开关：关掉后任何情况都不弹。'),
  thresholdSeconds: z
    .number()
    .min(0)
    .default(DEFAULTS.thresholdSeconds)
    .description('只在耗时达到这个秒数的 turn 结束时弹（出错通知不受此限）。'),
  summaryChars: z
    .number()
    .min(0)
    .default(DEFAULTS.summaryChars)
    .description('通知里附的回答摘要字数上限（取最后一条回答的开头）；0 = 不附摘要。'),
  channel: z
    .union([z.const('toast'), z.const('balloon')])
    .default(DEFAULTS.channel)
    .description(
      'toast = WinRT 吐司（默认，进通知中心 + 弹横幅）；balloon = 托盘气泡（备用，不依赖 AUMID 注册）。',
    ),
  sound: z.boolean().default(DEFAULTS.sound).description('是否带提示音。'),
  showIcon: z.boolean().default(DEFAULTS.showIcon).description('吐司左侧是否显示插件自带的图标（icon.png）。'),
  notifyOnError: z.boolean().default(DEFAULTS.notifyOnError).description('出错时弹通知（不受耗时阈值限制）。'),
  notifyOnAborted: z.boolean().default(DEFAULTS.notifyOnAborted).description('被中断时也弹（默认不弹）。'),
  notifySubagents: z
    .boolean()
    .default(DEFAULTS.notifySubagents)
    .description('子会话（subagent / workflow）也弹（默认静音，避免刷屏）。'),
  appId: z
    .string()
    .default(DEFAULTS.appId)
    .description('吐司的 AppUserModelID。必须是 DSH 注册过的那个（当前为 com.deepseek.dsh）。'),
  debug: z.boolean().default(DEFAULTS.debug).description('在宿主日志里打印判定过程。'),
});

export function apply(ctx, config) {
  const state = {
    cfg: mergeConfig(config),
    /** @type {Map<string, { at: number, cwd?: string }>} */
    starts: new Map(),
    /** @type {Set<import('node:child_process').ChildProcess>} */
    children: new Set(),
  };

  const log = (...args) => {
    if (state.cfg.debug) console.log('[dsh-notify]', ...args);
  };

  const notify = (notice, options) => sendNotification(state, notice, options);

  /** 读一遍 live 设置（设置页 / `/notify` 改完即时生效）。 */
  const refresh = () => {
    const settings = ctx.get('settings');
    if (!settings || typeof settings.describe !== 'function') return;
    try {
      const views = settings.describe({ redactSecrets: true });
      const mine = Array.isArray(views) ? views.find((view) => view && view.ns === ROW_ID) : undefined;
      if (mine && mine.value && typeof mine.value === 'object') {
        state.cfg = mergeConfig({ ...state.cfg, ...mine.value });
      }
    } catch (error) {
      log('read settings failed', error);
    }
  };

  refresh();
  ctx.on('settings/document-updated', (ns) => {
    if (!ns || ns === ROW_ID) refresh();
  });

  // ---- turn 计时 + 结束判定 ------------------------------------------------
  const keyOf = (session, turn) => `${session?.id ?? '?'}#${turn}`;

  const recordStart = (session, event) => {
    const turn = event.data?.turn;
    if (state.starts.size > 400) {
      // 极端情况下（大量 turn 没有 end）丢掉最老的一半，避免无界增长。
      for (const old of [...state.starts.keys()].slice(0, 200)) state.starts.delete(old);
    }
    state.starts.set(keyOf(session, turn), { at: Date.now(), cwd: session?.header?.cwd });
  };

  const fallbackDuration = (session, turn, now) => {
    try {
      const events = session?.ownEvents?.() ?? [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type !== 'turn/start') continue;
        if (event.data?.turn !== turn) break;
        const stamp = Number(event.time);
        if (!Number.isFinite(stamp)) return undefined;
        const dayMs = 24 * 3600 * 1000;
        // 会话日志的 time 若是 epoch 毫秒就直接用；若是秒就换算；都对不上（单调时钟等）就放弃。
        const asMillis = now - stamp;
        if (asMillis >= 0 && asMillis < dayMs) return asMillis;
        const asSeconds = now - stamp * 1000;
        if (asSeconds >= 0 && asSeconds < dayMs) return asSeconds;
        return undefined;
      }
    } catch (error) {
      log('fallback duration failed', error);
    }
    return undefined;
  };

  const handleTurnEnd = (session, event) => {
    const turn = event.data?.turn;
    const reason = event.data?.reason;
    const key = keyOf(session, turn);
    const started = state.starts.get(key);
    state.starts.delete(key);

    const cfg = state.cfg;
    if (!cfg.enabled) return log('skip: disabled', key);

    const header = session?.header ?? {};
    const isChild = header.origin === 'subagent' || Boolean(header.parentSession);
    if (isChild && !cfg.notifySubagents) return log('skip: subagent', key);

    const now = Date.now();
    const ms = typeof started?.at === 'number' ? now - started.at : fallbackDuration(session, turn, now);
    const cwd = started?.cwd ?? header.cwd;
    const notice = decideToast(reason, ms, cfg, {
      summary: cfg.summaryChars > 0 ? summarize(lastAssistantText(session, turn), cfg.summaryChars) : '',
      label: sessionLabel(ctx, session, cwd),
    });
    if (!notice) return log('skip', reason?.kind, key, ms);
    log('notify', notice.title, notice.lines);
    notify(notice);
  };

  ctx.on('session/event', (session, event) => {
    try {
      if (!event) return;
      if (event.type === 'turn/start') return recordStart(session, event);
      if (event.type === 'turn/end') return handleTurnEnd(session, event);
    } catch (error) {
      console.error('[dsh-notify] session/event handler failed', error);
    }
  });

  // ---- /notify 语令：随时开关、发测试通知 -----------------------------------
  const commands = ctx.get('commands');
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'notify',
        description: '桌面通知：/notify on | off | status | test | <秒数>',
        input: { hint: 'on | off | status | test | <秒数>' },
        handler: async (invocation) => {
          const settings = ctx.get('settings');
          const write = async (patch) => {
            if (!settings || typeof settings.update !== 'function') {
              return { kind: 'error', text: '设置服务不可用：请改 profile 的 cordis.patch.yml 里 dsh-notify 行的 config。' };
            }
            await settings.update(ROW_ID, patch);
            state.cfg = mergeConfig({ ...state.cfg, ...patch });
            return undefined;
          };
          const raw = String(invocation?.rawInput ?? '').trim();
          const seconds = Number(raw);

          if (raw === 'on' || raw === 'off') {
            const enabled = raw === 'on';
            const failed = await write({ enabled });
            if (failed) return failed;
            return { kind: 'success', text: enabled ? '桌面通知已开启。' : '桌面通知已关闭。' };
          }
          if (raw === 'test') {
            const result = await notify(
              { title: 'DSH · 测试通知', lines: ['看到这条说明通知通道正常', '点一下应该能把 DSH 窗口唤到前台'] },
              { wait: true },
            );
            return { kind: result?.ok ? 'success' : 'error', text: describeChannel(result) };
          }
          if (raw !== '' && raw !== 'status' && Number.isFinite(seconds) && seconds >= 0) {
            const value = Math.round(seconds);
            const failed = await write({ thresholdSeconds: value });
            if (failed) return failed;
            return { kind: 'success', text: `桌面通知阈值已设为 ${value} 秒。` };
          }
          if (raw !== '' && raw !== 'status') {
            return { kind: 'error', text: '用法：/notify on | off | status | test | <秒数>' };
          }
          return { kind: 'success', text: statusText(state.cfg) };
        },
      }),
    );
  }

  // ---- 卸载时收尾：杀掉还在跑的 powershell，绝不留僵尸 -----------------------
  ctx.effect(() => () => {
    for (const child of state.children) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    state.children.clear();
    state.starts.clear();
  });
}

// ---------------------------------------------------------------------------
// 判定 / 文案
// ---------------------------------------------------------------------------

function mergeConfig(value) {
  const config = value && typeof value === 'object' ? value : {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (config[key] !== undefined && config[key] !== null) merged[key] = config[key];
  }
  merged.thresholdSeconds = Number(merged.thresholdSeconds);
  if (!Number.isFinite(merged.thresholdSeconds) || merged.thresholdSeconds < 0) {
    merged.thresholdSeconds = DEFAULTS.thresholdSeconds;
  }
  return merged;
}

function statusText(cfg) {
  return [
    `桌面通知：${cfg.enabled ? '开' : '关'}`,
    `通道：${cfg.channel === 'toast' ? 'WinRT 吐司' : '托盘气泡'}`,
    `阈值：${cfg.thresholdSeconds} 秒`,
    `摘要字数：${cfg.summaryChars > 0 ? `${cfg.summaryChars} 字` : '不附摘要'}`,
    `声音：${cfg.sound ? '开' : '关'}`,
    `出错时弹：${cfg.notifyOnError ? '是' : '否'}（不受阈值限制）`,
    `中断时弹：${cfg.notifyOnAborted ? '是' : '否'}`,
    `子会话弹：${cfg.notifySubagents ? '是' : '否'}`,
  ].join('\n');
}

function describeChannel(result) {
  if (!result) return '通知未发出（非 Windows 平台）。';
  if (result.channel === 'balloon') return '测试通知已用托盘气泡发出，看屏幕右下角；点气泡也能唤回 DSH。';
  if (result.channel === 'winrt') return '测试通知已用 WinRT 吐司发出；点一下应该能把 DSH 窗口唤到前台。';
  return `通知发送失败：${result.error ?? `powershell 退出码 ${result.code}`}`;
}

function decideToast(reason, ms, cfg, meta) {
  const kind = reason?.kind;
  const long = typeof ms === 'number' && Number.isFinite(ms) && ms >= cfg.thresholdSeconds * 1000;
  const summary = meta?.summary ?? '';
  const took = typeof ms === 'number' && Number.isFinite(ms) ? `用时 ${formatDuration(ms)}` : '';
  const footer = [meta?.label, took].filter(Boolean).join(' · ');
  const lines = (first) => [first, summary, footer].filter(Boolean);

  switch (kind) {
    case 'completed':
      return long ? { title: 'DSH · 答完了', lines: lines('') } : null;
    case 'max-tokens':
      return long ? { title: 'DSH · 到输出上限了', lines: lines('') } : null;
    case 'error':
      // 出错比「答完」更重要：不受阈值限制。
      return cfg.notifyOnError ? { title: 'DSH · 出错了', lines: lines(errorLine(reason)) } : null;
    case 'aborted':
      if (!cfg.notifyOnAborted) return null;
      return long ? { title: 'DSH · 已中断', lines: lines('') } : null;
    default:
      // blocked / interrupted / forked：不算一段活干完，不打扰。
      return null;
  }
}

/** 取这一轮最后一条 assistant 消息的纯文本。 */
function lastAssistantText(session, turn) {
  try {
    const events = session?.ownEvents?.() ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'assistant/message') continue;
      if (event.data?.turn !== turn) break;
      const blocks = event.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  } catch {
    /* 摘要只是锦上添花，失败就不附 */
  }
  return '';
}

/** 把 markdown 噪音洗掉，压成一行短摘要。 */
function summarize(text, max) {
  if (!max || !text) return '';
  const cleaned = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(cleaned, max);
}

/** 通知里的会话标识：优先会话标题，退回工作目录名。 */
function sessionLabel(ctx, session, cwd) {
  try {
    const title = ctx.get('sessionTitle')?.get?.(session)?.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  } catch {
    /* 标题服务不可用就退回目录名 */
  }
  return cwd ? basename(String(cwd)) : '';
}

function errorLine(reason) {
  const failure = reason?.error ?? {};
  const message = String(failure.message ?? failure.code ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return message ? truncate(message, 80) : '模型请求失败';
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(ms) {
  const total = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

// ---------------------------------------------------------------------------
// PowerShell 通道
// ---------------------------------------------------------------------------

/**
 * 发一条通知。先 WinRT 吐司，退出码非 0 再退回托盘气泡。
 * @returns {Promise<{ ok: boolean, channel: string, code?: number, error?: string }> | undefined}
 */
function sendNotification(state, notice, options = {}) {
  if (process.platform !== 'win32') return options.wait ? Promise.resolve({ ok: false, channel: 'none' }) : undefined;

  const attempt = (channel) =>
    new Promise((resolve) => {
      const encoded = Buffer.from(buildScript(channel, state.cfg, notice), 'utf16le').toString('base64');
      let child;
      try {
        child = spawn(
          powershellPath(),
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
          // stdio 必须是 ignore：本机沙箱下用管道捕获会 EPERM。
          { stdio: 'ignore', windowsHide: true, detached: false },
        );
      } catch (error) {
        resolve({ ok: false, channel, code: -1, error: String(error?.message ?? error) });
        return;
      }

      state.children.add(child);
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        state.children.delete(child);
        resolve(payload);
      };
      const timer = setTimeout(() => finish({ ok: false, channel, code: -1, error: 'timeout' }), 15000);
      timer.unref?.();
      child.on('exit', (code) => {
        clearTimeout(timer);
        finish({ ok: code === 0, channel, code: code ?? -1 });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ ok: false, channel, code: -1, error: String(error?.message ?? error) });
      });
    });

  const task = (async () => {
    // 本机实测：WinRT 吐司会被系统接受并写进通知中心，但横幅常被“全屏应用/勿扰”压掉；
    // 托盘气泡则是肉眼可见的，所以默认走气泡，toast 作为可选项。
    const preferred = state.cfg.channel === 'toast' ? 'winrt' : 'balloon';
    let result = await attempt(preferred);
    if (!result.ok) {
      if (state.cfg.debug) {
        console.error('[dsh-notify]', preferred, 'failed', result.code, result.error ?? '');
      }
      result = await attempt(preferred === 'winrt' ? 'balloon' : 'winrt');
    }
    remember(result, notice);
    return result;
  })();

  if (options.wait) return task;
  task.catch((error) => console.error('[dsh-notify] notify failed', error));
  return undefined;
}

function remember(result, notice) {
  try {
    writeFileSync(
      DIAGNOSTIC_PATH,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          ...result,
          title: notice.title,
          body: (notice.lines ?? []).join('\n'),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* 诊断文件写不了不影响通知本身 */
  }
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  try {
    if (existsSync(absolute)) return absolute;
  } catch {
    /* fall through */
  }
  return 'powershell.exe';
}

function buildScript(channel, cfg, notice) {
  return channel === 'balloon' ? buildBalloonScript(cfg, notice) : buildWinrtScript(cfg, notice);
}

function buildWinrtScript(cfg, notice) {
  // PS 5.1 里 ToastAudio 不可用，声音只能靠 XML 的 <audio> 元素。
  const audio =
    cfg.sound === false ? '<audio silent="true" />' : '<audio src="ms-winsoundevent:Notification.Default" />';
  // activationType=protocol + launch=dsh://open：点一下把 DSH 主窗口唤到前台。
  // shell 侧对 dsh:// 的处理是 open-url(mac) / second-instance(win) → focusPrimaryWindow()，
  // dsh: 协议已注册在 HKCU\Software\Classes\dsh。它不解析具体会话，所以只能跳到 DSH，不能跳到某条会话。
  const lines = [notice.title, ...(notice.lines ?? [])].slice(0, 4);
  const texts = lines.map((line) => `<text>${xmlEscape(line)}</text>`).join('');
  // appLogoOverride：吐司左侧那张图。不写的话 Windows 只会显示 AUMID（DeepSeek Harness）自带的图标。
  const logo =
    existsSync(ICON_FILE) && cfg.showIcon !== false
      ? `<image placement="appLogoOverride" src="${xmlEscape(pathToFileURL(ICON_FILE).href)}" />`
      : '';
  const xml =
    '<toast activationType="protocol" launch="dsh://open" duration="long"><visual>' +
    `<binding template="ToastGeneric">${texts}${logo}</binding>` +
    `</visual>${audio}</toast>`;
  // XML 走 base64 传入，彻底避开中文、引号和 here-string 的转义问题。
  const xmlBase64 = Buffer.from(xml, 'utf8').toString('base64');
  const appId = String(cfg.appId || 'DSH').replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$xmlText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${xmlBase64}'))`,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xmlText)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`,
  ].join('\r\n');
}

function buildBalloonScript(cfg, notice) {
  // 主通道：纯 Win32 托盘气泡，不需要 AUMID 注册，本机实测可见。
  // 注意两点：气泡要靠消息泵才能渲染（DoEvents），且气泡跟随进程存活，所以要等几秒再退出。
  const titleB64 = Buffer.from(notice.title, 'utf8').toString('base64');
  const bodyB64 = Buffer.from((notice.lines ?? []).join('\n'), 'utf8').toString('base64');
  const sound = cfg.sound === false ? '' : '[System.Media.SystemSounds]::Asterisk.Play()';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    `$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${titleB64}'))`,
    `$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${bodyB64}'))`,
    '$icon = New-Object System.Windows.Forms.NotifyIcon',
    '$icon.Icon = [System.Drawing.SystemIcons]::Information',
    '$icon.Text = "DSH"',
    '$icon.Visible = $true',
    '$icon.BalloonTipTitle = $title',
    '$icon.BalloonTipText = $body',
    '$icon.ShowBalloonTip(8000)',
    sound,
    // 气泡也能点：点了同样把 DSH 窗口唤到前台。
    '$icon.add_BalloonTipClicked({ Start-Process "dsh://open" })',
    // 没有消息泵气泡就不会渲染；这里边泵边等，气泡消失后再收拾托盘图标。
    '$deadline = (Get-Date).AddSeconds(10)',
    'while ((Get-Date) -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 120 }',
    '$icon.Visible = $false',
    '$icon.Dispose()',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
