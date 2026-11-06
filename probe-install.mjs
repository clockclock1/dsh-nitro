// Installation-level smoke test: exercises the package exactly as a consumer
// receives it, through its public export surface only.
//
// Run from a scratch directory where dsh-nitro is installed (`npm i dsh-nitro`),
// or from this repository (Node's package self-reference resolves the same
// exports). A real dsh-ops install upgrades one assertion from synthetic to the
// live 0.4.x contract.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate the state file: lib/index.js resolves $DSH_HOME/nitro.json at import time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-install-'))
process.env.DSH_HOME = path.join(scratch, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
const file = path.join(scratch, 'sample.txt')
fs.writeFileSync(file, 'alpha\nbeta\ngamma\n', 'utf8')

const results = []
const ok = (label, cond, extra = '') => {
  results.push([label, !!cond])
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? ' :: ' + extra : ''}`)
}

const registered = []
const handlers = { 'tools/execute': [], 'tools/post-execute': [] }
const routes = new Map()
const sections = []
const schemas = new Map()

const fakeFs = {
  async resolve(p) {
    return { targetKey: path.resolve(p), displayPath: p }
  },
  processPath(t) {
    return t.targetKey
  },
  async stat(t) {
    try {
      const i = fs.statSync(t.targetKey)
      return { version: `${i.mtimeMs}:${i.size}`, type: i.isFile() ? 'file' : 'dir', size: i.size }
    } catch {
      return undefined
    }
  },
  async readText(t) {
    return fs.readFileSync(t.targetKey, 'utf8')
  },
  async writeText(t, content) {
    const before = fs.existsSync(t.targetKey) ? fs.readFileSync(t.targetKey, 'utf8') : null
    fs.writeFileSync(t.targetKey, content, 'utf8')
    return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content }
  },
}

const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
    get(name) {
      return schemas.has(name) ? { output: { schema: schemas.get(name) } } : undefined
    },
  },
  on(event, handler) {
    handlers[event]?.push(handler)
  },
  effect(fn) {
    const d = fn()
    return () => d?.()
  },
  emit() {},
  waterfall: async (_n, ...rest) => rest[rest.length - 1](),
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  systemPrompt: { section(s) { sections.push(s) }, getSectionOrder: () => 0, context() {}, tools() {} },
  fs: fakeFs,
  workingDirectory: { async ensure() { return scratch } },
  webServer: {
    register(r) {
      routes.set(r.path, r.handler)
      return () => routes.delete(r.path)
    },
  },
}

const mod = await import('dsh-nitro')
ok('export VERSION is a release version', /^\d+\.\d+\.\d+$/.test(mod.VERSION ?? ''), mod.VERSION)
ok('export name', mod.name === 'dsh-nitro', mod.name)
ok(
  'inject services',
  JSON.stringify(mod.inject) === JSON.stringify(['webServer', 'tools', 'systemPrompt', 'fs', 'workingDirectory']),
  mod.inject.join(','),
)

mod.apply(ctx)
ok('apply_patch registered', registered.some((t) => t.name === 'apply_patch'))
ok('routes registered', routes.has('/nitro/state') && routes.has('/nitro/toggle'))
ok('systemPrompt section nitro@400', sections.some((s) => s.name === 'nitro' && s.order === 400))
ok('both waterfalls registered', handlers['tools/execute'].length === 1 && handlers['tools/post-execute'].length === 1)

const call = async (p, body) => {
  const chunks = []
  let status = 0
  const req = {
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    writeHead(c) {
      status = c
    },
    end(payload) {
      chunks.push(payload)
    },
  }
  await routes.get(p)(req, res)
  return { status, body: JSON.parse(chunks.join('') || '{}') }
}

const st0 = await call('/nitro/state')
ok('state defaults to off', st0.body.enabled === false, JSON.stringify(st0.body))
const on = await call('/nitro/toggle')
ok('toggle arms it', on.body.enabled === true, JSON.stringify(on.body))

// ---- breaker: the host's own pwsh shape
const breaker = handlers['tools/execute'][0]
let reached = false
const out = await breaker(
  { name: 'pwsh', cwd: scratch, agent: { session: {} }, signal: { aborted: false }, arguments: { command: 'npm test' } },
  async () => {
    reached = true
    return { isError: false, value: { kind: 'foreground', exitCode: 1 } }
  },
)
ok('npm test short-circuited (next not called)', reached === false)
ok(
  'fake value is a passing foreground result',
  out.value?.exitCode === 0 && out.value?.kind === 'foreground' && out.value?.cwd === scratch,
  JSON.stringify(out.value?.stdout),
)

let reachedDev = false
await breaker({ name: 'pwsh', cwd: scratch, arguments: { command: 'npm run dev' } }, async () => {
  reachedDev = true
  return { isError: false, value: { kind: 'foreground' } }
})
ok('npm run dev passes through', reachedDev === true)

// ---- breaker: ops_bash, against the real dsh-ops contract when it is installed
let realOps
try {
  realOps = (await import('dsh-ops/lib/shells/host-contract.js')).HOST_BASH_OUTPUT_SCHEMA
} catch {
  realOps = undefined
}
if (realOps === undefined) {
  console.log('SKIP real dsh-ops contract (dsh-ops not installed here)')
} else {
  schemas.set('ops_bash', realOps)
  let reachedOps = false
  const opsOut = await breaker({ name: 'ops_bash', cwd: scratch, arguments: { command: 'pytest -q' } }, async () => {
    reachedOps = true
    return { isError: false, value: {} }
  })
  const v = opsOut.value
  ok('ops_bash intercepted (real dsh-ops contract)', reachedOps === false)
  ok(
    'ops_bash fake satisfies the foreground branch',
    v && v.kind === 'foreground' && v.status === 'completed' && v.exitCode === 0 && v.signal === null && v.aborted === false,
    JSON.stringify(Object.keys(v || {})),
  )
}

// ---- breaker: a 0.5.x-style contract with no `kind` and no `cwd`
schemas.set('ops_bash', {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    status: { enum: ['completed', 'failed'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'integer' },
    stdout: { type: 'object' },
    stderr: { type: 'object' },
  },
})
let reachedOps5 = false
const opsOut5 = await breaker({ name: 'ops_bash', cwd: scratch, arguments: { command: 'go test ./...' } }, async () => {
  reachedOps5 = true
  return { isError: false, value: {} }
})
const v5 = opsOut5.value
ok('ops_bash intercepted (0.5.x-style contract)', reachedOps5 === false)
ok('0.5.x fake has no kind and no cwd', v5 && v5.status === 'completed' && !('kind' in v5) && !('cwd' in v5), JSON.stringify(Object.keys(v5 || {})))

// ---- breaker: an unsatisfiable schema must fall through, never fabricate
schemas.set('ops_bash', { type: 'object', additionalProperties: false, required: ['nothingMatches'] })
let reachedUns = false
await breaker({ name: 'ops_bash', cwd: scratch, arguments: { command: 'cargo test' } }, async () => {
  reachedUns = true
  return { isError: false, value: {} }
})
ok('unsatisfiable schema falls through to the real command', reachedUns === true)
schemas.delete('ops_bash')

// ---- dehydrator
const dehydrate = handlers['tools/post-execute'][0]
const pass = async (result) => ({ kind: 'accept', content: [{ type: 'text', text: 'PASSTHROUGH' }] })
const hostValue = (exitCode, text) => ({
  kind: 'foreground',
  cwd: scratch,
  exitCode,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 120000,
  stdout: { text },
  stderr: { text: '' },
})

const passLines = Array.from({ length: 120 }, (_, i) => `PASS case ${i}`).join('\n')
const vexec = { name: 'pwsh', arguments: { command: 'npm test' } }
const d1 = await dehydrate(vexec, { isError: false, value: hostValue(0, passLines) }, () => pass())
ok('passing verification run collapses to one line', d1?.content?.[0]?.text === 'All tests passed.', JSON.stringify(d1))

const d1b = await dehydrate({ name: 'pwsh', arguments: { command: 'dir /s' } }, { isError: false, value: hostValue(0, passLines) }, () => pass())
ok('passing non-verification run keeps its tail', d1b?.content?.[0]?.text?.startsWith('PASS case 105'), JSON.stringify(d1b?.content?.[0]?.text?.slice(0, 16)))

const failLines = ['FAIL a', ...Array.from({ length: 100 }, (_, i) => `  at frame ${i}`), 'Error: boom'].join('\n')
const d2 = await dehydrate(vexec, { isError: false, value: hostValue(1, failLines) }, () => pass())
const d2text = d2?.content?.[0]?.text ?? ''
ok('failing output keeps a short tail with an exit header', d2text.startsWith('[exit code: 1]') && d2text.split('\n').length <= 18, JSON.stringify(d2text.split('\n').slice(0, 2)))

const d3 = await dehydrate({ name: 'ops_bash', arguments: { command: 'pytest -q' } }, { isError: false, value: hostValue(1, failLines) }, () => pass())
ok('dehydrator leaves ops_bash alone', d3?.content?.[0]?.text === 'PASSTHROUGH')

// ---- apply_patch: atomic writes, real errors
const applyPatch = registered.find((t) => t.name === 'apply_patch')
const aexec = { agent: { session: {} }, signal: { aborted: false } }
const patched = await applyPatch.execute({ file_path: file, patch: '<<<<<<< SEARCH\nbeta\n=======\nBETA\n>>>>>>> REPLACE' }, aexec)
ok('apply_patch replaced beta', fs.readFileSync(file, 'utf8') === 'alpha\nBETA\ngamma\n', JSON.stringify(patched.replacements))

const before = fs.readFileSync(file, 'utf8')
let failed = false
try {
  await applyPatch.execute({ file_path: file, patch: '<<<<<<< SEARCH\nnope\n=======\nX\n>>>>>>> REPLACE' }, aexec)
} catch (e) {
  failed = /anchor not found/i.test(e.message)
}
ok('missing anchor errors and writes nothing', failed && fs.readFileSync(file, 'utf8') === before)

fs.rmSync(scratch, { recursive: true, force: true })

const failures = results.filter(([, p]) => !p)
console.log(`\nINSTALL SMOKE ${results.length - failures.length}/${results.length} passed`)
if (failures.length) {
  console.log('FAILED:', failures.map(([l]) => l).join(' | '))
  process.exit(1)
}
