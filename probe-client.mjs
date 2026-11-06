// Load the browser bundle in Node with a stub module loader: catches syntax
// errors, missing requires, and a bad apply()/inject shape without a browser.
import fs from 'node:fs'
import vm from 'node:vm'

const path = 'D:/code/调系统/dsh-nitro/lib/client.js'
const source = fs.readFileSync(path, 'utf8')

const registered = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry)
      },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, enabled: false }) }),
  setInterval: () => 0,
  clearInterval() {},
  Event: class Event {
    constructor(type) {
      this.type = type
    }
  },
  console,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (registered.length !== 1) throw new Error(`expected 1 module registration, got ${registered.length}`)
const entry = registered[0]
if (entry.id !== 'dsh-nitro') throw new Error(`bad id ${entry.id}`)

const react = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  createElement: (...args) => ({ args }),
}
const jsxRuntime = { jsx: (...a) => ({ a }), jsxs: (...a) => ({ a }) }

const exports = entry.factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require("${specifier}")`)
})

console.log('exports:', Object.keys(exports).join(', '))
console.log('inject:', JSON.stringify(exports.inject))

const slots = []
const ctx = {
  slots: {
    inject(name, factory) {
      console.log('slots.inject <-', name)
      const disposer = factory()
      return () => disposer
    },
    register(options, component) {
      slots.push({ options, component })
      console.log('slots.register <-', JSON.stringify({ name: options.name, id: options.id, order: options.order }))
      return () => {}
    },
  },
}
exports.apply(ctx)
if (slots.length !== 1) throw new Error('apply() registered no slot entry')

// The component must render a button and must bail out without a session id.
const none = slots[0].component({ sessionId: undefined })
if (none !== null) throw new Error(`expected null without sessionId, got ${JSON.stringify(none)}`)

const rendered = slots[0].component({ sessionId: 's1' })
const text = JSON.stringify(rendered)
if (!text.includes('极速')) throw new Error('rendered button has no label')

// buttonModel holds the whole visual rule set, so assert it directly: the
// mid-turn lock is the part a user must not be able to click through, and a
// React stub cannot drive state into the component.
const model = exports.buttonModel
if (typeof model !== 'function') throw new Error('buttonModel is not exported')
const idle = model({ enabled: false })
const armed = model({ enabled: true })
const pending = model({ enabled: false, busy: true })
const runningOn = model({ enabled: true, running: true })
const runningOff = model({ enabled: false, running: true })

const checks = [
  ['idle button is clickable', idle.disabled === false && idle.suffix === 'OFF' && idle.armed === false],
  ['armed button is clickable and marked', armed.disabled === false && armed.suffix === 'ON' && armed.armed === true],
  ['a pending POST disables the button', pending.disabled === true],
  ['a running session locks the button', runningOn.disabled === true && runningOff.disabled === true],
  ['the lock is visible, not silent', runningOn.suffix === '运行中' && runningOff.suffix === '运行中'],
  ['the lock explains itself', runningOn.title.includes('本轮结束后')],
  [
    'every title names the per-session scope',
    armed.title.includes('只影响这个会话') && idle.title.includes('只影响这个会话'),
  ],
]
for (const [label, pass] of checks) {
  console.log(` ${pass ? 'ok  ' : 'FAIL'} ${label}`)
  if (!pass) throw new Error(`client check failed: ${label}`)
}

console.log('render without session:', none)
console.log('render with session :', text.slice(0, 200), '...')
console.log('\nCLIENT BUNDLE OK')
