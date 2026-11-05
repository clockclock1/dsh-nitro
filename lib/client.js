// dsh-nitro — client half.
//
// One pill button in the composer's left slot. Clicking it flips the host-side
// switch through POST /nitro/toggle; state is polled from
// GET /nitro/state so every open tab agrees.
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
    const STATE_URL = '/nitro/state'
    const TOGGLE_URL = '/nitro/toggle'
    const SYNC_EVENT = 'dsh-nitro:changed'

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
    }

    function useFastModeState() {
      const [state, setState] = React.useState({ enabled: false, ready: false })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true

        const refresh = () => {
          fetch(STATE_URL, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
              if (!alive || body === null || body === undefined) return
              setState({ enabled: body.enabled === true, ready: true })
            })
            .catch(() => {})
        }

        refresh()
        const timer = setInterval(refresh, 4000)
        const onSync = () => refresh()
        window.addEventListener(SYNC_EVENT, onSync)

        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener(SYNC_EVENT, onSync)
        }
      }, [])

      const toggle = React.useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(TOGGLE_URL, { method: 'POST' })
          const body = response.ok ? await response.json() : null
          if (body !== null && body !== undefined) {
            setState({ enabled: body.enabled === true, ready: true })
          }
          window.dispatchEvent(new Event(SYNC_EVENT))
        } catch {
        } finally {
          setBusy(false)
        }
      }, [])

      return { enabled: state.enabled, ready: state.ready, busy, toggle }
    }

    function FastModeToggle(props) {
      const fast = useFastModeState()
      if (!props.sessionId) return null

      const armed = fast.enabled
      const label = armed ? '⚡ 极速' : '⚡ 极速'
      const title = armed
        ? 'Nitro 极速模式已开启：跳过测试与构建命令、终端输出脱水、改动走 apply_patch 局部替换。点击关闭。'
        : 'Nitro 极速模式已关闭：恢复正常工具行为。点击开启。'

      return jsx('button', {
        type: 'button',
        title,
        'aria-pressed': armed,
        'aria-busy': fast.busy || undefined,
        disabled: fast.busy,
        onClick: () => void fast.toggle(),
        style: {
          ...(armed ? theme.armed : theme.idle),
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
          cursor: fast.busy ? 'progress' : 'pointer',
          transition: 'opacity 120ms ease, border-color 120ms ease, background 120ms ease',
          whiteSpace: 'nowrap',
        },
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
          children: [
            jsx('span', { 'aria-hidden': 'true', children: label }),
            jsx('span', {
              style: { fontSize: '10px', letterSpacing: '0.06em', opacity: 0.85 },
              children: armed ? 'ON' : 'OFF',
            }),
          ],
        }),
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
            label: 'Nitro 极速交付模式',
          },
          FastModeToggle,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FastModeToggle = FastModeToggle

    return module.exports
  },
})
