/**
 * dsh-sit-alarm — Host half.
 *
 * 状态机：40 分钟专注 → 第 37 分钟提醒 → 40 分钟到点自动进入 5 分钟休息
 * → 休息结束只发提醒、不自动开始下一轮。全程由 Host 计时，页面关了也照走；
 * 浏览器面板通过 Connection 的自定义 RPC 通道 `/sit-alarm` 轮询状态、下达指令。
 *
 * 通知走 PowerShell + WinRT 吐司（Desktop 宿主是纯 Node 进程，没有 electron.Notification）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'sit-alarm'

/** Host Connection supplies the RPC channel that feeds the browser panel. */
export const inject = ['connection', 'webServer']

const CONFIG_PATH = join(homedir(), '.dsh', 'sit-alarm.json')
const DEFAULTS = { workMinutes: 40, warnMinutes: 3, breakMinutes: 5, sound: true, autoStartOnLoad: false }
const MINUTE = 60000

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
      sound: parsed.sound === undefined ? DEFAULTS.sound : Boolean(parsed.sound),
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

function buildToastScript(title, body, sound) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Reminder" />' : '<audio silent="true" />'
  const xml = '<toast duration="long"><visual><binding template="ToastGeneric">'
    + `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>`
    + `</binding></visual>${audio}</toast>`
  return [
    "$ErrorActionPreference = 'Stop'",
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
  debug(`apply v3 inject connection=${typeof ctx.connection} webServer=${typeof ctx.webServer}`)
  let cfg = loadConfig()
  let phase = 'idle'
  let round = 0
  let startedAt = 0
  let endsAt = 0
  let warnAt = 0
  let warned = false
  let pausedFrom = null
  let remainingMs = 0
  let timer

  const log = (...args) => {
    if (process.env.DSH_SIT_ALARM_DEBUG) console.log('[sit-alarm]', ...args)
  }

  function notify(title, body) {
    log('notify:', title)
    debug(`toast: ${title}`)
    if (process.platform !== 'win32') return
    let child
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(buildToastScript(title, body, cfg.sound !== false), 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true })
    } catch {
      return
    }
    children.add(child)
    child.on('exit', () => { children.delete(child) })
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
      timer = setTimeout(tick, Math.max(0, endsAt - Date.now()))
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
        beginBreak()
        return
      }
      scheduleNext()
      return
    }
    if (phase === 'break' && now >= endsAt) endBreak()
  }

  function beginBreak() {
    clearTimer()
    phase = 'break'
    startedAt = Date.now()
    endsAt = startedAt + minutesToMs(cfg.breakMinutes, DEFAULTS.breakMinutes)
    notify(`休息 ${Math.round(cfg.breakMinutes)} 分钟`, '站起来走两步、拉伸肩颈，倒计时结束会再提醒你。')
    scheduleNext()
  }

  function endBreak() {
    clearTimer()
    phase = 'breakDone'
    endsAt = 0
    notify('休息达标', '可以开始下一轮了。不会自动开始，回来点一下就行。')
  }

  function start() {
    clearTimer()
    phase = 'working'
    round += 1
    startedAt = Date.now()
    endsAt = startedAt + minutesToMs(cfg.workMinutes, DEFAULTS.workMinutes)
    warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
    warned = false
    scheduleNext()
  }

  function pause() {
    if (phase !== 'working' && phase !== 'break') return false
    clearTimer()
    pausedFrom = phase
    remainingMs = Math.max(0, endsAt - Date.now())
    phase = 'paused'
    return true
  }

  function resume() {
    if (phase !== 'paused' || pausedFrom === null) return false
    phase = pausedFrom
    pausedFrom = null
    const now = Date.now()
    endsAt = now + remainingMs
    if (phase === 'working') {
      warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
    }
    scheduleNext()
    return true
  }

  function cancel() {
    clearTimer()
    phase = 'idle'
    pausedFrom = null
    remainingMs = 0
    endsAt = 0
    warnAt = 0
    warned = false
  }

  function live() {
    return phase === 'working' || phase === 'break'
  }

  function snapshot() {
    const now = Date.now()
    return {
      phase,
      round,
      remainingMs: live() ? Math.max(0, endsAt - now) : 0,
      endsAt: live() ? endsAt : 0,
      warnAt: phase === 'working' ? warnAt : 0,
      workMinutes: cfg.workMinutes,
      warnMinutes: cfg.warnMinutes,
      breakMinutes: cfg.breakMinutes,
      startedAt,
      now,
    }
  }

  function applyConfig(next) {
    cfg = {
      workMinutes: Number(next.workMinutes) > 0 ? Number(next.workMinutes) : cfg.workMinutes,
      warnMinutes: Number(next.warnMinutes) >= 0 ? Number(next.warnMinutes) : cfg.warnMinutes,
      breakMinutes: Number(next.breakMinutes) > 0 ? Number(next.breakMinutes) : cfg.breakMinutes,
      sound: next.sound === undefined ? cfg.sound : Boolean(next.sound),
      autoStartOnLoad: next.autoStartOnLoad === undefined ? cfg.autoStartOnLoad : Boolean(next.autoStartOnLoad),
    }
    log('config:', JSON.stringify(cfg))
    if (phase === 'working') {
      warnAt = cfg.warnMinutes > 0 ? endsAt - minutesToMs(cfg.warnMinutes, DEFAULTS.warnMinutes) : 0
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
      case 'config': {
        const next = { ...cfg }
        for (const key of ['workMinutes', 'warnMinutes', 'breakMinutes', 'sound']) {
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
    let lastProbe = 0
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
