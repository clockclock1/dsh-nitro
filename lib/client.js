// dsh-nitro — client half.
//
// One pill button in the composer's left slot. The switch is **per
// conversation**: every request carries the slot's sessionId, the host keeps
// one entry per session, and a session that was never touched follows the
// default (on).
//
// The button is disabled while the conversation is running. Flipping mid-turn
// would change which commands get faked partway through, so the host refuses it
// too (409 session-busy) — the disabled state here is the visible half of that
// rule, the POST check is the half that actually holds.
//
// Deliberately no CSS file, no locale service, no slot store: the component is
// self-contained and cannot break other composer entries.

window.__ModuleLoader__.load({
  id: 'dsh-nitro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    const SLOT = 'conversation.input.left'
    // While a turn is running the composer hides its left slot, so the switch
    // itself disappears exactly when the state matters most. The conversation
    // header is rendered for the whole turn, so a read-only badge goes there.
    const HEADER_SLOT = 'conversation.session.header.actions'
    const STATE_URL = '/nitro/state'
    const TOGGLE_URL = '/nitro/toggle'
    const SYNC_EVENT = 'dsh-nitro:changed'
    const POLL_MS = 1500
    const HEADER_POLL_MS = 2500

    const theme = {
      idle: {
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.35)',
        color: 'inherit',
        opacity: 0.72,
      },
      armed: {
        background: 'linear-gradient(135deg, rgba(255,176,32,0.22), rgba(255,96,32,0.22))',
        border: '1px solid rgba(255,150,40,0.85)',
        color: 'rgb(255,150,40)',
        opacity: 1,
      },
      locked: {
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.22)',
        color: 'inherit',
        opacity: 0.45,
      },
    }

    /**
     * Everything the button looks like and does, as data. Kept out of the
     * component so the probes can assert the disabled/label rules without a
     * React renderer.
     */
    function buttonModel(input) {
      const enabled = input !== undefined && input.enabled === true
      const running = input !== undefined && input.running === true
      const busy = input !== undefined && input.busy === true
      const scope = '（只影响这个会话）'

      if (running) {
        return {
          armed: enabled,
          locked: true,
          disabled: true,
          suffix: '运行中',
          cursor: 'not-allowed',
          skin: theme.locked,
          title:
            (enabled ? 'Nitro 极速模式已开启' : 'Nitro 极速模式已关闭') +
            scope +
            '。这个会话正在运行，本轮结束后才能切换。',
        }
      }

      return {
        armed: enabled,
        locked: false,
        disabled: busy,
        suffix: enabled ? 'ON' : 'OFF',
        cursor: busy ? 'progress' : 'pointer',
        skin: enabled ? theme.armed : theme.idle,
        title: enabled
          ? 'Nitro 极速模式已开启' + scope + '：跳过测试与构建命令、终端输出脱水、改动走 apply_patch 局部替换。点击关闭。'
          : 'Nitro 极速模式已关闭' + scope + '：这个会话恢复正常工具行为。点击开启。',
      }
    }

    /** What the header badge shows while a turn is running. */
    function runningBadgeModel(input) {
      const enabled = input !== undefined && input.enabled === true
      const running = input !== undefined && input.running === true
      if (!running) return null
      return {
        text: enabled ? '⚡ 极速 · 已开启' : '⚡ 极速 · 已关闭',
        state: enabled ? 'on' : 'off',
        skin: enabled ? theme.armed : theme.locked,
        title:
          (enabled ? 'Nitro 极速模式已开启' : 'Nitro 极速模式已关闭') +
          '（只影响这个会话）。本轮正在运行，结束后才能切换。',
      }
    }

    function useFastModeState(sessionId, pollMs) {
      const interval = typeof pollMs === 'number' && pollMs > 0 ? pollMs : POLL_MS
      const [state, setState] = React.useState({
        enabled: false,
        running: false,
        ready: false,
        notice: null,
      })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return () => {
            alive = false
          }
        }

        const url = STATE_URL + '?session=' + encodeURIComponent(sessionId)
        const refresh = () => {
          fetch(url, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
              if (!alive || body === null || body === undefined) return
              setState((previous) => ({
                enabled: body.enabled === true,
                running: body.running === true,
                ready: true,
                notice: previous.notice,
              }))
            })
            .catch(() => {})
        }

        refresh()
        const timer = setInterval(refresh, interval)
        const onSync = () => refresh()
        window.addEventListener(SYNC_EVENT, onSync)

        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener(SYNC_EVENT, onSync)
        }
      }, [sessionId, interval])

      const toggle = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        setBusy(true)
        try {
          const response = await fetch(TOGGLE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !state.enabled }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok) {
            // 409: the host refused because the turn is still running.
            setState((previous) => ({
              enabled: previous.enabled,
              running: true,
              ready: true,
              notice: body && typeof body.message === 'string' ? body.message : null,
            }))
            return
          }
          if (body !== null && body !== undefined) {
            setState({
              enabled: body.enabled === true,
              running: body.running === true,
              ready: true,
              notice: null,
            })
          }
          window.dispatchEvent(new Event(SYNC_EVENT))
        } catch {
        } finally {
          setBusy(false)
        }
      }, [sessionId, state.enabled])

      return {
        enabled: state.enabled,
        running: state.running,
        ready: state.ready,
        notice: state.notice,
        busy,
        toggle,
      }
    }

    function FastModeToggle(props) {
      const sessionId = props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : undefined
      const fast = useFastModeState(sessionId)
      if (sessionId === undefined || sessionId.length === 0) return null

      const model = buttonModel({ enabled: fast.enabled, running: fast.running, busy: fast.busy })

      return jsx('button', {
        type: 'button',
        title: fast.notice === null || fast.notice === undefined ? model.title : fast.notice,
        'aria-pressed': model.armed,
        'aria-busy': fast.busy || undefined,
        'aria-disabled': model.disabled || undefined,
        'data-nitro-locked': model.locked ? 'true' : undefined,
        disabled: model.disabled,
        onClick: () => void fast.toggle(),
        style: {
          ...model.skin,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '28px',
          padding: '0 10px',
          marginRight: '4px',
          borderRadius: '14px',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1',
          cursor: model.cursor,
          transition: 'opacity 120ms ease, border-color 120ms ease, background 120ms ease',
          whiteSpace: 'nowrap',
        },
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
          children: [
            jsx('span', { 'aria-hidden': 'true', children: '⚡ 极速' }),
            jsx('span', {
              style: { fontSize: '10px', letterSpacing: '0.06em', opacity: 0.85 },
              children: model.suffix,
            }),
          ],
        }),
      })
    }

    /**
     * Read-only badge in the conversation header. Renders only while the turn is
     * running, so an idle conversation keeps exactly one nitro control (the
     * composer pill) instead of two.
     */
    function RunningBadge(props) {
      const sessionId = props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : undefined
      const fast = useFastModeState(sessionId, HEADER_POLL_MS)
      const model = runningBadgeModel({ enabled: fast.enabled, running: fast.running })
      if (sessionId === undefined || sessionId.length === 0 || model === null) return null

      return jsx('span', {
        role: 'status',
        title: model.title,
        'data-nitro-running': model.state,
        'aria-live': 'polite',
        style: {
          ...model.skin,
          display: 'inline-flex',
          alignItems: 'center',
          height: '24px',
          padding: '0 8px',
          borderRadius: '12px',
          fontSize: '11px',
          lineHeight: '1',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        },
        children: model.text,
      })
    }

    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'nitro',
            order: 20,
            label: 'Nitro 极速交付模式（按会话）',
          },
          FastModeToggle,
        ),
      )

      ctx.slots.inject(HEADER_SLOT, () =>
        ctx.slots.register(
          {
            name: HEADER_SLOT,
            id: 'nitro-running',
            order: 30,
            label: 'Nitro 极速模式状态（运行中）',
          },
          RunningBadge,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FastModeToggle = FastModeToggle
    exports.buttonModel = buttonModel
    exports.RunningBadge = RunningBadge
    exports.runningBadgeModel = runningBadgeModel

    return module.exports
  },
})
