/**
 * dsh-sit-alarm — Client half.
 *
 * 侧边栏底部的久坐提醒卡片：注册在 `sidebar.footer.action`（Settings 那一行上方），
 * 和侧栏同宽，不占工作区。收起时是一行紧凑摘要；侧栏折成 rail 时是一个 ⏱ 按钮。
 * 状态与指令都走 Host 的 `/api/sit-alarm` 精确路由，Host 计时，页面刷新不丢。
 * 第 37 分钟进入提醒窗口、以及阶段切换时，卡片自动展开。
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
      breakWarn: '休息快结束了',
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
      expand: '展开',
      idleHint: '开始一轮 {w} 分钟专注',
      breakDoneHint: '休息够了，随时可以开始下一轮',
      stats: '今日 {r} 轮 · 专注 {m} 分',
    }

    const en = {
      title: 'Sit reminder',
      idle: 'Not started',
      working: 'Focusing',
      paused: 'Paused',
      break: 'On a break',
      breakDone: 'Break complete',
      breakWarn: 'Break almost over',
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
      expand: 'Expand',
      idleHint: 'Start a {w} min focus round',
      breakDoneHint: 'Break complete — start the next round when ready',
      stats: 'Today {r} rounds · {m} min focus',
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
    const WARN = 'var(--dsw-alias-state-warning-primary, #e0a100)'
    const FG = 'var(--dsw-alias-label-primary, #eceff3)'
    const MUTED = 'var(--dsw-alias-label-secondary, #9aa0a6)'
    const CARD = 'rgba(127,127,127,0.14)'
    const BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))'

    const buttonBase = {
      border: `0.5px solid ${BORDER}`,
      background: 'transparent',
      color: FG,
      borderRadius: 7,
      padding: '4px 9px',
      fontSize: 11.5,
      lineHeight: '16px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
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
      const wide = props.wide !== false
      const phase = state.phase
      const live = phase === 'working' || phase === 'break'
      const remaining = live ? Math.max(0, (state.endsAt || 0) - Date.now()) : 0
      const total = phase === 'working'
        ? (state.workMinutes || 0) * 60000
        : phase === 'break' ? (state.breakMinutes || 0) * 60000 : 0
      const progress = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0
      const warnMs = (state.warnMinutes || 0) * 60000
      const inWarn = phase === 'working' && warnMs > 0 && remaining <= warnMs
      const breakWarnMs = (state.breakWarnMinutes || 0) * 60000
      const inBreakWarn = phase === 'break' && breakWarnMs > 0 && remaining <= breakWarnMs
      const accentColor = inWarn || inBreakWarn ? WARN : ACCENT
      const label = phase === 'working'
        ? (inWarn ? t('warnSoon') : t('working'))
        : phase === 'break' ? (inBreakWarn ? t('breakWarn') : t('break'))
          : phase === 'paused' ? t('paused')
            : phase === 'breakDone' ? t('breakDone') : t('idle')
      const timeText = live ? clock(remaining) : phase === 'breakDone' ? '✓' : '—'
      const act = props.act
      const today = state.stats || { rounds: 0, focusMinutes: 0 }
      const statsLine = t('stats')
        .replace('{r}', String(today.rounds || 0))
        .replace('{m}', String(today.focusMinutes || 0))

      // 侧栏折成 56px rail 时只留一个按钮，点一下把侧栏展开。
      if (!wide) {
        return h('button', {
          type: 'button',
          title: live ? `${t('title')} ${clock(remaining)}` : t('title'),
          onClick: props.openSidebar,
          style: {
            ...buttonBase,
            width: 34, height: 34, padding: 0,
            borderRadius: 9,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14,
            color: inWarn || inBreakWarn ? WARN : FG,
          },
        }, '⏱')
      }

      if (!state.panelOpen) {
        return h('button', {
          type: 'button',
          title: t('expand'),
          onClick: props.expand,
          style: {
            ...buttonBase,
            width: '100%',
            boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '6px 9px',
            borderRadius: 9,
            background: CARD,
            border: `0.5px solid ${inWarn || inBreakWarn ? accentColor : BORDER}`,
            textAlign: 'left',
          },
        },
        h('span', { style: { fontSize: 13 } }, '⏱'),
        h('span', {
          style: {
            flex: 1, minWidth: 0, fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, live ? clock(remaining) : t('title')),
        h('span', { style: { fontSize: 10.5, color: MUTED } }, phase === 'idle' ? t('idle') : label))
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
          width: '100%',
          boxSizing: 'border-box',
          minWidth: 0,
          padding: '8px 10px 9px',
          borderRadius: 10,
          background: CARD,
          border: `0.5px solid ${inWarn || inBreakWarn ? accentColor : BORDER}`,
          color: FG,
          fontFamily: 'inherit',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontSize: 11.5, fontWeight: 600, letterSpacing: 0.2 } }, t('title')),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          state.online === false
            ? h('span', { title: t('offline'), style: { width: 6, height: 6, borderRadius: 6, background: '#e5484d' } })
            : null,
          h('button', {
            type: 'button', title: t('collapse'), onClick: props.close,
            style: { ...buttonBase, border: 'none', padding: '1px 3px', color: MUTED, fontSize: 11.5 },
          }, '✕'))),
      h('div', {
        style: {
          marginTop: 1, fontSize: 26, lineHeight: '32px', fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', letterSpacing: 0.4,
          color: phase === 'breakDone' ? accentColor : FG,
        },
      }, timeText),
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minHeight: 16 } },
        h('span', { style: { fontSize: 11, color: inWarn || inBreakWarn ? accentColor : MUTED } }, label),
        h('span', { style: { fontSize: 10.5, color: MUTED, whiteSpace: 'nowrap' } }, hint)),
      h('div', { style: { marginTop: 5, height: 3, borderRadius: 3, background: 'rgba(127,127,127,0.22)', overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: `${Math.round(progress * 100)}%`, background: accentColor, transition: 'width 400ms linear' } })),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } }, ...actions),
      state.online === false
        ? h('div', { style: { marginTop: 6, fontSize: 10.5, color: '#e5484d', lineHeight: '15px' } }, `${t('offline')}${state.error ? ` · ${state.error}` : ''}`)
        : null,
      h('div', {
        style: {
          marginTop: 6, fontSize: 10.5, color: MUTED, lineHeight: '14px',
          fontVariantNumeric: 'tabular-nums', opacity: 0.9,
        },
      }, statsLine))
    }

    return {
      inject: ['slots', 'locale', 'connection', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sit-alarm: copy')

        const post = async (op, payload) => {
          const result = await ctx.connection.rpc.call('/api', 'sit-alarm', { op, ...(payload || {}) })
          if (!result || result.ok !== true) throw new Error((result && result.error && result.error.message) || 'rpc failed')
          return result.value
        }

        const store = createStore({
          phase: 'idle', round: 0, remainingMs: 0, endsAt: 0, warnAt: 0,
          workMinutes: 40, warnMinutes: 3, breakMinutes: 5, breakWarnMinutes: 0,
          stats: { rounds: 0, focusMinutes: 0, breaks: 0, breakMinutes: 0 },
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

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'sit-alarm',
          locale: NS,
          order: 10,
          inject: () => ({
            hooks: { sit: store },
            act,
            expand: () => store.patch({ panelOpen: true }),
            close: () => store.patch({ panelOpen: false }),
            openSidebar: () => ctx.layout.toggleSidebar(),
          }),
        }, Panel))
      },
    }
  },
})
