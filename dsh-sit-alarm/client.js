/**
 * dsh-sit-alarm — Client half.
 *
 * 右下角浮动倒计时面板：折叠成小圆片，展开是卡片。
 * 状态与指令都走 Host 的自定义 RPC 通道 `/sit-alarm`（Host 计时，页面刷新不丢）。
 * 第 37 分钟进入提醒窗口、以及阶段切换时，面板自动展开。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sit-alarm',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sitAlarm'
    const POLL_MS = 2000

    const zh = {
      title: '久坐提醒',
      idle: '还没开始',
      working: '专注中',
      paused: '已暂停',
      break: '休息中',
      breakDone: '休息达标',
      start: '开始 {n} 分钟',
      startNext: '开始下一轮',
      pause: '暂停',
      resume: '继续',
      cancel: '结束',
      finishBreak: '提前结束休息',
      warnSoon: '快结束了，准备站起来',
      breakOver: '休息够了，点「开始下一轮」继续',
      breakHint: '站起来走两步、拉伸肩颈',
      round: '第 {n} 轮',
      offline: '未连接 DSH',
      collapse: '收起',
      idleHint: '开始一轮 {w} 分钟专注',
      breakDoneHint: '休息够了，随时可以开始下一轮',
    }

    const en = {
      title: 'Sit reminder',
      idle: 'Not started',
      working: 'Focusing',
      paused: 'Paused',
      break: 'On a break',
      breakDone: 'Break complete',
      start: 'Start {n} min',
      startNext: 'Start next round',
      pause: 'Pause',
      resume: 'Resume',
      cancel: 'Stop',
      finishBreak: 'End break early',
      warnSoon: 'Almost done — get ready to stand up',
      breakOver: 'Break is enough — start the next round when ready',
      breakHint: 'Stand up, walk, stretch',
      round: 'Round {n}',
      offline: 'Not connected',
      collapse: 'Collapse',
      idleHint: 'Start a {w} min focus round',
      breakDoneHint: 'Break complete — start the next round when ready',
    }

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[sit-alarm] listener failed', error)
          }
        }
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          state = next
          publish()
        },
        patch(patch) {
          state = { ...state, ...patch }
          publish()
        },
      }
    }

    const pad = (value) => String(value).padStart(2, '0')
    function clock(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
    }

    const ACCENT = 'var(--dsw-alias-state-business-primary, #4d6bfe)'
    const FG = '#f3f4f6'
    const MUTED = '#a8b0bb'
    const CARD = 'rgba(20, 22, 27, 0.92)'
    const BORDER = 'rgba(255,255,255,0.16)'

    const buttonBase = {
      border: `0.5px solid ${BORDER}`,
      background: 'transparent',
      color: FG,
      borderRadius: 8,
      padding: '5px 10px',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      fontFamily: 'inherit',
    }
    const primaryButton = {
      ...buttonBase,
      background: ACCENT,
      border: '0.5px solid transparent',
      color: '#fff',
      fontWeight: 500,
    }

    function Panel(props) {
      const state = props.useSit((value) => value)
      const [, rerender] = React.useState(0)
      React.useEffect(() => {
        const handle = setInterval(() => rerender((value) => value + 1), 500)
        return () => { clearInterval(handle) }
      }, [])

      const t = props.t || ((key) => key)
      const phase = state.phase
      const live = phase === 'working' || phase === 'break'
      const remaining = live ? Math.max(0, (state.endsAt || 0) - Date.now()) : 0
      const total = phase === 'working'
        ? (state.workMinutes || 0) * 60000
        : phase === 'break' ? (state.breakMinutes || 0) * 60000 : 0
      const progress = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0
      const warnMs = (state.warnMinutes || 0) * 60000
      const inWarn = phase === 'working' && warnMs > 0 && remaining <= warnMs
      const accentColor = inWarn ? 'var(--dsw-alias-state-warning-primary, #e0a100)' : ACCENT
      const label = phase === 'working'
        ? (inWarn ? t('warnSoon') : t('working'))
        : phase === 'break' ? t('break')
          : phase === 'paused' ? t('paused')
            : phase === 'breakDone' ? t('breakDone') : t('idle')
      const timeText = live ? clock(remaining) : phase === 'breakDone' ? '✓' : '—'
      const act = props.act

      if (!state.panelOpen) {
        return h('div', {
          style: {
            position: 'fixed', right: 18, bottom: 96, zIndex: 70, pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 6,
          },
        }, h('button', {
          type: 'button',
          title: t('title'),
          onClick: props.open,
          style: {
            ...buttonBase,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px 5px 8px',
            borderRadius: 999,
            background: CARD,
            border: `0.5px solid ${inWarn || live ? accentColor : BORDER}`,
            boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
            fontSize: 12,
          },
        },
        h('span', { style: { fontSize: 13, lineHeight: '16px' } }, '⏱'),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, live ? clock(remaining) : t('title'))))
      }

      const actions = []
      if (phase === 'working') {
        actions.push(h('button', { key: 'pause', type: 'button', style: buttonBase, onClick: () => act({ action: 'pause' }) }, t('pause')))
        actions.push(h('button', { key: 'stop', type: 'button', style: buttonBase, onClick: () => act({ action: 'cancel' }) }, t('cancel')))
      } else if (phase === 'paused') {
        actions.push(h('button', { key: 'resume', type: 'button', style: primaryButton, onClick: () => act({ action: 'resume' }) }, t('resume')))
        actions.push(h('button', { key: 'stop', type: 'button', style: buttonBase, onClick: () => act({ action: 'cancel' }) }, t('cancel')))
      } else if (phase === 'break') {
        actions.push(h('button', { key: 'next', type: 'button', style: primaryButton, onClick: () => act({ action: 'start' }) }, t('startNext')))
        actions.push(h('button', { key: 'finish', type: 'button', style: buttonBase, onClick: () => act({ action: 'finishBreak' }) }, t('finishBreak')))
      } else if (phase === 'breakDone') {
        actions.push(h('button', { key: 'start', type: 'button', style: primaryButton, onClick: () => act({ action: 'start' }) }, t('startNext')))
      } else {
        actions.push(h('button', { key: 'start', type: 'button', style: primaryButton, onClick: () => act({ action: 'start' }) },
          t('start').replace('{n}', String(state.workMinutes || 40))))
      }

      const hint = phase === 'break' ? t('breakHint')
        : phase === 'breakDone' ? t('breakDoneHint')
          : phase === 'idle' ? t('idleHint').replace('{w}', String(state.workMinutes || 40))
            : t('round').replace('{n}', String(state.round || 1))

      return h('div', {
        style: {
          position: 'fixed', right: 18, bottom: 96, zIndex: 70, pointerEvents: 'auto',
          width: 216, boxSizing: 'border-box',
          padding: '10px 12px 12px',
          borderRadius: 12,
          background: CARD,
          backdropFilter: 'blur(26px) saturate(1.35)',
          WebkitBackdropFilter: 'blur(26px) saturate(1.35)',
          border: `0.5px solid ${inWarn || phase === 'break' ? accentColor : BORDER}`,
          boxShadow: '0 10px 30px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.06)',
          color: FG,
          fontFamily: 'inherit',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontSize: 12, fontWeight: 600, letterSpacing: 0.2 } }, t('title')),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          state.online === false
            ? h('span', { title: t('offline'), style: { width: 6, height: 6, borderRadius: 6, background: '#e5484d' } })
            : null,
          h('button', {
            type: 'button', title: t('collapse'), onClick: props.close,
            style: { ...buttonBase, border: 'none', padding: '2px 4px', color: MUTED, fontSize: 12 },
          }, '✕'))),
      h('div', { style: { marginTop: 6, fontSize: 11, color: inWarn ? accentColor : MUTED, minHeight: 16 } }, label),
      h('div', {
        style: {
          marginTop: 2, fontSize: 34, lineHeight: '40px', fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', letterSpacing: 0.5,
          color: phase === 'breakDone' ? accentColor : FG,
        },
      }, timeText),
      h('div', { style: { marginTop: 6, height: 3, borderRadius: 3, background: 'rgba(127,127,127,0.22)', overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: `${Math.round(progress * 100)}%`, background: accentColor, transition: 'width 400ms linear' } })),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } }, ...actions),
      state.online === false
        ? h('div', { style: { marginTop: 8, fontSize: 11, color: '#e5484d', lineHeight: '16px' } }, `${t('offline')}${state.error ? ` · ${state.error}` : ''}`)
        : null,
      h('div', { style: { marginTop: 8, fontSize: 11, color: MUTED, lineHeight: '16px' } }, hint))
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sit-alarm: copy')

        const post = async (op, payload) => {
          const result = await ctx.connection.rpc.call('/api', 'sit-alarm', { op, ...(payload || {}) })
          if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'rpc failed')
          return result.value
        }

        const store = createStore({
          phase: 'idle', round: 0, remainingMs: 0, endsAt: 0, warnAt: 0,
          workMinutes: 40, warnMinutes: 3, breakMinutes: 5,
          online: false, error: null, panelOpen: true,
        })

        const applyState = (value, options) => {
          const prev = store.getSnapshot()
          const next = { ...value }
          next.receivedAt = Date.now()
          next.online = true
          next.error = null
          next.panelOpen = prev.panelOpen
          const warnLimit = (next.warnMinutes || 0) * 60000
          const enteredWarn = next.phase === 'working' && warnLimit > 0 && next.remainingMs <= warnLimit
            && !(prev.phase === 'working' && prev.remainingMs <= (prev.warnMinutes || 0) * 60000)
          if (next.phase !== prev.phase) next.panelOpen = options && options.forceOpen ? true : next.phase !== 'idle'
          if (enteredWarn) next.panelOpen = true
          if (options && options.forceOpen) next.panelOpen = true
          store.set(next)
        }

        const poll = async () => {
          try {
            const value = await post('state', null)
            if (value) applyState(value)
            else store.patch({ online: false })
          } catch (error) {
            store.patch({ online: false, error: String((error && error.message) || error) })
          }
        }

        const act = async (payload) => {
          try {
            const value = await post('command', payload)
            if (value) applyState(value, { forceOpen: true })
            else store.patch({ online: false })
          } catch (error) {
            store.patch({ online: false, error: String((error && error.message) || error) })
          }
        }

        void poll()
        const polling = setInterval(() => { void poll() }, POLL_MS)
        ctx.effect(() => () => { clearInterval(polling) }, 'sit-alarm: polling')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'sit-alarm',
          locale: NS,
          order: 40,
          inject: () => ({
            hooks: { sit: store },
            act,
            open: () => store.patch({ panelOpen: true }),
            close: () => store.patch({ panelOpen: false }),
          }),
        }, Panel))
      },
    }
  },
})
