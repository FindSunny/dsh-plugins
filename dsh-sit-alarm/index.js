/**
 * dsh-sit-alarm — Host half.
 *
 * 状态机：40 分钟专注 → 第 37 分钟提醒 → 40 分钟到点自动进入 5 分钟休息
 * → 休息结束前 1 分钟预告 → 休息结束只发提醒、不自动开始下一轮。
 * 全程由 Host 计时，页面关了也照走；浏览器面板通过 `/api/sit-alarm` 精确路由
 * 轮询状态、下达指令。跨天的轮次统计单独落盘，重启不丢。
 *
 * 通知走 PowerShell + WinRT 吐司（Desktop 宿主是纯 Node 进程，没有 electron.Notification）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'sit-alarm'

/** Host Connection supplies the fetch route that feeds the browser panel. */
export const inject = ['connection', 'webServer']

const CONFIG_PATH = join(homedir(), '.dsh', 'sit-alarm.json')
const STATS_PATH = join(homedir(), '.dsh', 'sit-alarm-stats.json')
const STATS_KEEP_DAYS = 45
const DEFAULTS = {
  workMinutes: 40,
  warnMinutes: 3,
  breakMinutes: 5,
  breakWarnMinutes: 1,
  sound: true,
  gamingGuard: true,
  autoStartOnLoad: false,
}
const MINUTE = 60000

/** 补零到两位。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地日期键 YYYY-MM-DD；跨天统计按本地时区切，不按 UTC。 */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 一天的空统计。log 存每一轮的明细，用来事后找节奏。 */
function emptyDay() {
  return { rounds: 0, focusSeconds: 0, breaks: 0, breakSeconds: 0, skips: 0, log: [] }
}

/** 四舍五入到毫秒，同时挡住 NaN。 */
function minutesToMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n * MINUTE) : Math.round(fallback * MINUTE)
}

/**
 * 读取配置文件；缺失或损坏时回落到默认值，不阻塞插件激活。
 * @returns 生效的配置。
 */
function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
    const text = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return {
      workMinutes: Number(parsed.workMinutes) > 0 ? Number(parsed.workMinutes) : DEFAULTS.workMinutes,
      warnMinutes: Number(parsed.warnMinutes) >= 0 ? Number(parsed.warnMinutes) : DEFAULTS.warnMinutes,
      breakMinutes: Number(parsed.breakMinutes) > 0 ? Number(parsed.breakMinutes) : DEFAULTS.breakMinutes,
      breakWarnMinutes: Number(parsed.breakWarnMinutes) >= 0 ? Number(parsed.breakWarnMinutes) : DEFAULTS.breakWarnMinutes,
      sound: parsed.sound === undefined ? DEFAULTS.sound : Boolean(parsed.sound),
      gamingGuard: parsed.gamingGuard === undefined ? DEFAULTS.gamingGuard : Boolean(parsed.gamingGuard),
      autoStartOnLoad: parsed.autoStartOnLoad === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(config) {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch {
    /* 写不了配置只影响下次启动，不影响本轮计时 */
  }
}

/** 读统计文件；坏数据当成空的，别让统计拖垮计时。 */
function loadStats() {
  try {
    if (!existsSync(STATS_PATH)) return { version: 1, days: {} }
    const parsed = JSON.parse(readFileSync(STATS_PATH, 'utf8').replace(/^\uFEFF/, ''))
    const days = parsed && typeof parsed.days === 'object' && parsed.days !== null ? parsed.days : {}
    return { version: 1, days }
  } catch {
    return { version: 1, days: {} }
  }
}

/** 写统计文件，顺手裁掉过期天数。 */
function saveStats(stats) {
  try {
    const keys = Object.keys(stats.days).sort()
    while (keys.length > STATS_KEEP_DAYS) delete stats.days[keys.shift()]
    mkdirSync(dirname(STATS_PATH), { recursive: true })
    writeFileSync(STATS_PATH, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
  } catch {
    /* 统计写不了不影响计时 */
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * 起一个隐藏的 PowerShell 进程发 WinRT 吐司。
 * AUMID 必须是 Windows 认识的（com.deepseek.dsh 由 DSH 开始菜单快捷方式注册）。
 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const absolute = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  return existsSync(absolute) ? absolute : 'powershell.exe'
}

/**
 * 全屏/占用时的护栏：Win32 自带的「现在能不能打扰我」判断。
 * 退出码 3 = 被护栏拦下（没弹），Node 侧只记日志。
 */
function buildGuardLines() {
  const typeDef = 'using System; using System.Runtime.InteropServices; '
    + 'public static class NS { '
    + '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state); '
    + '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); '
    + '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); '
    + '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); '
    + '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); '
    + '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } '
    + '}'
  return [
    `Add-Type -TypeDefinition '${typeDef}'`,
    '$st = 0',
    '[void][NS]::SHQueryUserNotificationState([ref]$st)',
    // 2=BUSY 3=D3D 独占全屏 4=演示模式：这时别弹
    '$skip = $st -eq 2 -or $st -eq 3 -or $st -eq 4',
    'if (-not $skip) {',
    '  $h = [NS]::GetForegroundWindow()',
    '  if ($h -ne [IntPtr]::Zero) {',
    '    $rect = New-Object NS+RECT',
    '    [void][NS]::GetWindowRect($h, [ref]$rect)',
    '    $style = [NS]::GetWindowLong($h, -16)',
    '    $caption = ($style -band 0x00C00000) -ne 0',
    '    $sw = [NS]::GetSystemMetrics(0)',
    '    $sh = [NS]::GetSystemMetrics(1)',
    // 无标题栏 + 正好铺满主屏 = 无边框全屏（很多游戏这么跑）
    '    if ((-not $caption) -and ([Math]::Abs($rect.Left) -le 2) -and ([Math]::Abs($rect.Top) -le 2) -and ([Math]::Abs(($rect.Right - $rect.Left) - $sw) -le 2) -and ([Math]::Abs(($rect.Bottom - $rect.Top) - $sh) -le 2)) { $skip = $true }',
    '  }',
    '}',
    'if ($skip) { exit 3 }',
  ]
}

function buildToastScript(title, body, sound, guard) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Reminder" />' : '<audio silent="true" />'
  const xml = '<toast duration="long"><visual><binding template="ToastGeneric">'
    + `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>`
    + `</binding></visual>${audio}</toast>`
  return [
    "$ErrorActionPreference = 'Stop'",
    ...guard ? buildGuardLines() : [],
    `$xmlText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(xml, 'utf8').toString('base64')}'))`,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xmlText)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.deepseek.dsh').Show($toast)",
  ].join('\r\n')
}

export function apply(ctx) {
  const children = new Set()
  const debugPath = join(homedir(), '.dsh', 'sit-alarm-debug.log')
  const debug = (line) => {
    try {
      appendFileSync(debugPath, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 调试日志写不了就算 */
    }
  }
  debug(`apply v4 inject connection=${typeof ctx.connection} webServer=${typeof ctx.webServer}`)
  let cfg = loadConfig()
  const stats = loadStats()
  let phase = 'idle'
  let round = 0
  let startedAt = 0
  let endsAt = 0
  let warnAt = 0
  let warned = false
  let breakWarnAt = 0
  let breakWarned = false
  let pausedFrom = null
  let remainingMs = 0
  /** 本轮已累计的专注毫秒（暂停时结算，避免把暂停算进专注）。 */
  let focusMs = 0
  /** 本次休息已累计的毫秒。 */
  let breakMs = 0
  /** 当前这一段（专注或休息）的起始时刻，用于累计毫秒。 */
  let segmentStart = 0
  /** 最近一条「已完成专注」的明细，用来补 gapSec / bSec。 */
  let roundEntry = null
  /** 本轮专注跑完的时刻，用来算「隔了多久才去休息」。 */
  let workEndAt = 0
  let timer

  const log = (...args) => {
    if (process.env.DSH_SIT_ALARM_DEBUG) console.log('[sit-alarm]', ...args)
  }

  /** 今天这一格统计（只读，没有就返回空）。 */
  function todayStats() {
    const day = stats.days[dayKey()]
    return day && typeof day === 'object' ? day : emptyDay()
  }

  /** 今天这一格统计（可写，缺字段补齐）。 */
  function ensureDay() {
    const key = dayKey()
    const day = stats.days[key] && typeof stats.days[key] === 'object' ? stats.days[key] : emptyDay()
    if (!Array.isArray(day.log)) day.log = []
    stats.days[key] = day
    return day
  }

  /** 往今天的统计上累加，落盘。 */
  function bumpToday(patch) {
    const day = ensureDay()
    for (const [field, value] of Object.entries(patch)) day[field] = (Number(day[field]) || 0) + value
    saveStats(stats)
    debug(`stats ${dayKey()} ${JSON.stringify({ ...day, log: day.log.length })}`)
    return day
  }

  function notify(title, body) {
    log('notify:', title)
    debug(`toast: ${title}`)
    if (process.platform !== 'win32') return
    let child
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(buildToastScript(title, body, cfg.sound !== false, cfg.gamingGuard !== false), 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true })
    } catch {
      return
    }
    children.add(child)
    child.on('exit', (code) => {
      children.delete(child)
      debug(`toast exit ${code}`)
      if (code === 3) debug('toast skipped: fullscreen or busy')
    })
    child.on('error', () => { children.delete(child) })
  }

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function scheduleNext() {
    clearTimer()
    if (phase === 'working') {
      const target = warned || warnAt <= 0 ? endsAt : Math.min(warnAt, endsAt)
      timer = setTimeout(tick, Math.max(0, target - Date.now()))
    } else if (phase === 'break') {
      const target = breakWarned || breakWarnAt <= 0 ? endsAt : Math.min(breakWarnAt, endsAt)
      timer = setTimeout(tick, Math.max(0, target - Date.now()))
    }
  }

  function tick() {
    timer = undefined
    const now = Date.now()
    if (phase === 'working') {
      if (!warned && warnAt > 0 && now >= warnAt) {
        warned = true
        notify(`${Math.round(cfg.warnMinutes)} 分钟后该站起来了`, `这一轮还剩 ${Math.round(cfg.warnMinutes)} 分钟，收个尾。`)
      }
      if (now >= endsAt) {
        finishWork()
        return
      }
      scheduleNext()
      return
    }
    if (phase === 'break') {
      if (!breakWarned && breakWarnAt > 0 && now >= breakWarnAt) {
        breakWarned = true
        const left = cfg.breakWarnMinutes >= 1 ? `${Math.round(cfg.breakWarnMinutes)} 分钟` : '不到 1 分钟'
        notify('休息快结束了', `还有${left}，收个尾准备回来。`)
      }
      if (now >= endsAt) {
        endBreak()
        return
      }
      scheduleNext()
    }
  }

  /** 把这一段休息时间结算进今天统计。提前结束记一次 skip。 */
  function flushBreak(completed) {
    if (phase === 'break') breakMs += Math.max(0, Date.now() - segmentStart)
    if (breakMs <= 0) return
    const seconds = Math.round(breakMs / 1000)
    bumpToday({
      breakSeconds: seconds,
      ...completed ? { breaks: 1 } : { skips: 1 },
    })
    if (roundEntry !== null && roundEntry.bSec === null) {
      roundEntry.bSec = seconds
      roundEntry.bDone = completed
      saveStats(stats)
    }
    breakMs = 0
  }

  /** 专注跑完：记账、停在 workDone 等人工确认，不自动进休息。 */
  function finishWork() {
    clearTimer()
    focusMs += Math.max(0, Date.now() - segmentStart)
    const focusSeconds = Math.round(focusMs / 1000)
    focusMs = 0
    phase = 'workDone'
    endsAt = 0
    warnAt = 0
    workEndAt = Date.now()
    bumpToday({ rounds: 1, focusSeconds })
    const day = ensureDay()
    const entry = { at: workEndAt, w: cfg.workMinutes, f: focusSeconds, gapSec: null, bSec: null, bDone: false }
    day.log.push(entry)
    if (day.log.length > 120) day.log.shift()
    saveStats(stats)
    roundEntry = entry
    notify(`专注 ${Math.round(cfg.workMinutes)} 分钟完成`, `点「开始休息」进入 ${Math.round(cfg.breakMinutes)} 分钟休息。`)
  }

  function beginBreak() {
    clearTimer()
    phase = 'break'
    startedAt = Date.now()
    endsAt = startedAt + minutesToMs(cfg.breakMinutes, DEFAULTS.breakMinutes)
    breakWarnAt = cfg.breakWarnMinutes > 0 ? endsAt - Math.round(cfg.breakWarnMinutes * MINUTE) : 0
    breakWarned = false
    breakMs = 0
    segmentStart = startedAt
    // 「专注跑完」到「真的去休息」隔了多久，把这段时间也记下来。
    if (roundEntry !== null && roundEntry.gapSec === null) {
      roundEntry.gapSec = Math.max(0, Math.round((startedAt - workEndAt) / 1000))
      saveStats(stats)
    }
    notify(`休息 ${Math.round(cfg.breakMinutes)} 分钟`, '站起来走两步、拉伸肩颈，倒计时结束会再提醒你。')
    scheduleNext()
  }

  function endBreak() {
    clearTimer()
    flushBreak(true)
    phase = 'breakDone'
    endsAt = 0
    breakWarnAt = 0
    notify('休息达标', '可以开始下一轮了。不会自动开始，回来点一下就行。')
  }

  function start() {
    if (phase === 'break') flushBreak(false)
    clearTimer()
    phase = 'working'
    round += 1
    startedAt = Date.now()
    endsAt = startedAt + minutesToMs(cfg.workMinutes, DEFAULTS.workMinutes)
    warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
    warned = false
    focusMs = 0
    segmentStart = startedAt
    scheduleNext()
  }

  function pause() {
    if (phase !== 'working' && phase !== 'break') return false
    clearTimer()
    const now = Date.now()
    if (phase === 'working') focusMs += Math.max(0, now - segmentStart)
    else breakMs += Math.max(0, now - segmentStart)
    pausedFrom = phase
    remainingMs = Math.max(0, endsAt - now)
    phase = 'paused'
    return true
  }

  function resume() {
    if (phase !== 'paused' || pausedFrom === null) return false
    phase = pausedFrom
    pausedFrom = null
    const now = Date.now()
    endsAt = now + remainingMs
    segmentStart = now
    if (phase === 'working') {
      warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
    } else if (phase === 'break') {
      breakWarnAt = cfg.breakWarnMinutes > 0 ? endsAt - Math.round(cfg.breakWarnMinutes * MINUTE) : 0
    }
    scheduleNext()
    return true
  }

  function cancel() {
    if (phase === 'break') flushBreak(false)
    clearTimer()
    phase = 'idle'
    pausedFrom = null
    remainingMs = 0
    endsAt = 0
    warnAt = 0
    breakWarnAt = 0
    warned = false
    breakWarned = false
    focusMs = 0
    breakMs = 0
  }

  function live() {
    return phase === 'working' || phase === 'break'
  }

  function snapshot() {
    const now = Date.now()
    const today = todayStats()
    return {
      phase,
      round,
      remainingMs: live() ? Math.max(0, endsAt - now) : 0,
      endsAt: live() ? endsAt : 0,
      warnAt: phase === 'working' ? warnAt : 0,
      breakWarnAt: phase === 'break' ? breakWarnAt : 0,
      workMinutes: cfg.workMinutes,
      warnMinutes: cfg.warnMinutes,
      breakMinutes: cfg.breakMinutes,
      breakWarnMinutes: cfg.breakWarnMinutes,
      startedAt,
      now,
      stats: {
        rounds: Number(today.rounds) || 0,
        focusMinutes: Math.round((Number(today.focusSeconds) || 0) / 60),
        breaks: Number(today.breaks) || 0,
        breakMinutes: Math.round((Number(today.breakSeconds) || 0) / 60),
        skips: Number(today.skips) || 0,
      },
    }
  }

  function applyConfig(next) {
    cfg = {
      workMinutes: Number(next.workMinutes) > 0 ? Number(next.workMinutes) : cfg.workMinutes,
      warnMinutes: Number(next.warnMinutes) >= 0 ? Number(next.warnMinutes) : cfg.warnMinutes,
      breakMinutes: Number(next.breakMinutes) > 0 ? Number(next.breakMinutes) : cfg.breakMinutes,
      breakWarnMinutes: Number(next.breakWarnMinutes) >= 0 ? Number(next.breakWarnMinutes) : cfg.breakWarnMinutes,
      sound: next.sound === undefined ? cfg.sound : Boolean(next.sound),
      gamingGuard: next.gamingGuard === undefined ? cfg.gamingGuard : Boolean(next.gamingGuard),
      autoStartOnLoad: next.autoStartOnLoad === undefined ? cfg.autoStartOnLoad : Boolean(next.autoStartOnLoad),
    }
    log('config:', JSON.stringify(cfg))
    if (phase === 'working') {
      warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
      scheduleNext()
    } else if (phase === 'break') {
      breakWarnAt = cfg.breakWarnMinutes > 0 ? endsAt - Math.round(cfg.breakWarnMinutes * MINUTE) : 0
      scheduleNext()
    }
  }

  function command(payload) {
    const action = String((payload && payload.action) || '')
    switch (action) {
      case 'start':
        start()
        return { ok: true }
      case 'pause':
        return pause() ? { ok: true } : failure('not-running', '当前没有正在进行的计时')
      case 'resume':
        return resume() ? { ok: true } : failure('not-paused', '当前没有暂停的计时')
      case 'cancel':
        cancel()
        return { ok: true }
      case 'finishBreak':
        if (phase !== 'break') return failure('not-on-break', '当前不在休息阶段')
        endBreak()
        return { ok: true }
      case 'startBreak':
        if (phase !== 'workDone') return failure('not-work-done', '专注还没完成，先跑完这一轮')
        beginBreak()
        return { ok: true }
      case 'config': {
        const next = { ...cfg }
        for (const key of ['workMinutes', 'warnMinutes', 'breakMinutes', 'breakWarnMinutes', 'sound', 'gamingGuard']) {
          if (payload[key] !== undefined) next[key] = payload[key]
        }
        applyConfig(next)
        saveConfig(cfg)
        return { ok: true }
      }
      case 'status':
        return { ok: true }
      default:
        return failure('unknown-action', `未知指令 ${action || '(空)'}`)
    }
  }

  function failure(code, message) {
    return { ok: false, error: { code: `sit-alarm/${code}`, message, details: {} } }
  }

  // 配置文件被外部（例如智能体用写文件工具）改动后实时生效。
  watchFile(CONFIG_PATH, { interval: 700 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    applyConfig(loadConfig())
  })

  try {
    const disposer = ctx.connection.fetch.register({
      path: '/api/sit-alarm',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'unknown'
        const payload = (body && body.payload) || {}
        if (payload.op === 'command') debug(`command ${String(payload.action)}`)
        let result
        try {
          if (payload.op === 'state') result = { ok: true, value: snapshot() }
          else if (payload.op === 'command') {
            const outcome = command(payload)
            result = outcome.ok ? { ok: true, value: snapshot() } : outcome
          } else result = failure('unknown-op', `未知操作 ${String(payload.op)}`)
        } catch (error) {
          result = failure('internal', String((error && error.message) || error))
        }
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
    ctx.effect(() => disposer, 'sit-alarm: fetch route')
    debug('fetch route registered')
  } catch (error) {
    debug(`fetch route registration failed: ${(error && error.stack) || error}`)
    console.error('[sit-alarm] fetch route registration failed', error)
  }

  ctx.effect(() => () => {
    clearTimer()
    for (const child of children) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    children.clear()
  }, 'sit-alarm: timers')

  if (cfg.autoStartOnLoad) {
    debug('auto start on load')
    start()
  }
}
