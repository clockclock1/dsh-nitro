// End-to-end smoke test of dsh-nitro's host half against a mock ctx.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolation: the plugin resolves $DSH_HOME/nitro.json at import time, so the
// scratch home has to exist before the module loads — otherwise this probe
// rewrites the operator's real switch.
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-state-'))
process.env.DSH_HOME = stateHome

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-'))
const file = path.join(scratch, 'sample.txt')
fs.writeFileSync(file, 'line one\nline two\nline three\nline four\n', 'utf8')

const registered = []
const handlers = { 'tools/execute': [], 'tools/post-execute': [], 'agent/status': [] }
const routes = new Map()
const sections = []

const fakeFs = {
  async resolve(p) {
    return { targetKey: path.resolve(p), displayPath: p }
  },
  processPath(target) {
    return target.targetKey
  },
  async stat(target) {
    try {
      const info = fs.statSync(target.targetKey)
      return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : 'dir', size: info.size }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return fs.readFileSync(target.targetKey, 'utf8')
  },
  async writeText(target, content) {
    const before = fs.existsSync(target.targetKey) ? fs.readFileSync(target.targetKey, 'utf8') : null
    fs.writeFileSync(target.targetKey, content, 'utf8')
    return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content }
  },
}

const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
    get() {
      return undefined
    },
  },
  on(event, handler) {
    handlers[event]?.push(handler)
  },
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  emit() {},
  waterfall: async (_name, ...rest) => rest[rest.length - 1](),
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  systemPrompt: { section(s) { sections.push(s) }, getSectionOrder: () => 0, context() {}, tools() {} },
  fs: fakeFs,
  workingDirectory: { async ensure() { return scratch } },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

const mod = await import('file:///D:/code/%E8%B0%83%E7%B3%BB%E7%BB%9F/dsh-nitro/lib/index.js')
mod.apply(ctx)

console.log('@ tools registered:', registered.map((t) => t.name).join(', '))
console.log('@ routes:', [...routes.keys()].join(', '))
console.log('@ sections:', sections.map((s) => `${s.name}@${s.order}`).join(', '))
console.log('@ tools/execute handlers:', handlers['tools/execute'].length)
console.log('@ tools/post-execute handlers:', handlers['tools/post-execute'].length)

// ---- the switch is per session, driven through the routes

let checks = 0
let failures = 0
const expect = (label, ok, detail) => {
  checks += 1
  if (!ok) failures += 1
  console.log(` ${ok ? 'ok  ' : 'FAIL'} ${checks}. ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const api = mod.__probe

const call = async (p, body) => {
  const chunks = []
  let status = 0
  const req = {
    url: p,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    writeHead(code) {
      status = code
    },
    end(payload) {
      chunks.push(payload)
    },
  }
  await routes.get(p.split('?')[0])(req, res)
  return { status, body: JSON.parse(chunks.join('')) }
}

const freshA = await call('/nitro/state?session=sA')
expect('a brand-new session starts ON', freshA.body.enabled === true && freshA.body.running === false, `enabled=${freshA.body.enabled}`)
expect('state reports the session it answered for', freshA.body.sessionId === 'sA')

const offA = await call('/nitro/toggle', { sessionId: 'sA', enabled: false })
expect('POST toggle off for sA answers 200', offA.status === 200 && offA.body.enabled === false)

const freshB = await call('/nitro/state?session=sB')
expect('sB is untouched by sA', freshB.body.enabled === true)

const againA = await call('/nitro/state?session=sA')
expect('sA stays off on the next read', againA.body.enabled === false)
expect('only one session override was written', againA.body.overrides === 1, `overrides=${againA.body.overrides}`)

const noSession = await call('/nitro/state')
expect('a request without a session follows the default', noSession.body.enabled === true)

// ---- exercise apply_patch through the registered tool
const applyPatch = registered.find((t) => t.name === 'apply_patch')
const exec = { agent: { session: {} }, signal: { aborted: false } }

async function run(label, args) {
  try {
    const value = await applyPatch.execute(args, exec)
    console.log(`\n== ${label}: OK`, JSON.stringify({ path: value.path, blocks: value.blocks, replacements: value.replacements }))
    console.log('   render:', JSON.stringify(applyPatch.output.render(args, value)))
    return value
  } catch (error) {
    console.log(`\n== ${label}: ERROR ${error?.message}`)
    return undefined
  }
}

await run('happy path (one block)', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'line two', '=======', 'line two patched', '>>>>>>> REPLACE'].join('\n'),
})
console.log('   disk now:', JSON.stringify(fs.readFileSync(file, 'utf8')))

await run('missing anchor (must not write)', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'this text is absent', '=======', 'nope', '>>>>>>> REPLACE'].join('\n'),
})
console.log('   disk unchanged:', JSON.stringify(fs.readFileSync(file, 'utf8')))

await run('the earlier missing-anchor patch left disk untouched', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'line four', '=======', 'line four crlf-safe', '>>>>>>> REPLACE'].join('\n'),
})

await run('ambiguous anchor without replace_all', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'line', '=======', 'row', '>>>>>>> REPLACE'].join('\n'),
})

await run('malformed patch', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'line one', '=======', 'one'].join('\n'),
})

await run('no-op patch', {
  file_path: file,
  patch: ['<<<<<<< SEARCH', 'line three', '=======', 'line three', '>>>>>>> REPLACE'].join('\n'),
})

await run('two blocks in one call', {
  file_path: file,
  patch: [
    '<<<<<<< SEARCH', 'line one', '=======', 'LINE ONE', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', 'line two patched', '=======', 'LINE TWO', '>>>>>>> REPLACE',
  ].join('\n'),
})
console.log('   disk now:', JSON.stringify(fs.readFileSync(file, 'utf8')))

// ---- exercise the breaker + dehydrator
const breaker = handlers['tools/execute'][0]
const nextCalled = { count: 0 }
const next = async () => {
  nextCalled.count += 1
  return { isError: false, value: { kind: 'foreground', cwd: scratch, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: 'real', truncated: false }, stderr: { text: '', truncated: false } } }
}

const shellExec = (command, sessionId) => ({
  name: 'pwsh',
  arguments: { command, description: 'x' },
  agent: sessionId === undefined ? undefined : { session: { id: sessionId } },
  signal: { aborted: false },
})

console.log('\n-- breaker on `npm test`:')
console.log('   next called:', nextCalled.count)
const intercepted = await breaker(shellExec('npm test'), next)
console.log('   next called after:', nextCalled.count)
console.log('   returned:', JSON.stringify(intercepted.value).slice(0, 200))
console.log('   rendered:', JSON.stringify(registered.find((t) => t.name === 'apply_patch') && 'n/a'))

console.log('\n-- breaker on `npm run dev` (server, must pass through):')
const before = nextCalled.count
await breaker(shellExec('npm run dev'), next)
console.log('   next called delta:', nextCalled.count - before)

console.log('\n-- breaker on `git status` (not verification, must pass through):')
const before2 = nextCalled.count
await breaker(shellExec('git status'), next)
console.log('   next called delta:', nextCalled.count - before2)

console.log('\n-- breaker on `ops_bash npm test` (dsh-ops rung name):')
const beforeOps = nextCalled.count
const opsIntercepted = await breaker({ ...shellExec('npm test'), name: 'ops_bash' }, next)
console.log('   next called delta:', nextCalled.count - beforeOps, '| verdict:', opsIntercepted === 'REAL-RUN' ? 'PASSED THROUGH (bug)' : 'INTERCEPTED')

const dehydrate = handlers['tools/post-execute'][0]

console.log('\n-- dehydrator must not touch `ops_bash` (own result schema):')
const opsResult = { isError: false, value: { kind: 'foreground', cwd: scratch, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'), truncated: false }, stderr: { text: '', truncated: false } } }
const opsDehydrated = await dehydrate({ ...shellExec('npm test'), name: 'ops_bash' }, opsResult, async () => ({ kind: 'accept' }))
console.log('   verdict:', JSON.stringify(opsDehydrated) === '{"kind":"accept"}' ? 'LEFT ALONE (ok)' : 'REWRITTEN (bug)')

const resultPass = { isError: false, value: { kind: 'foreground', cwd: scratch, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: Array.from({ length: 300 }, (_, i) => `INFO test case ${i} passed`).join('\n'), truncated: false }, stderr: { text: '', truncated: false } } }
console.log('\n-- dehydrator, passing run:', JSON.stringify(await dehydrate(shellExec('pytest'), resultPass, async () => ({ kind: 'accept' }))))

const resultFail = {
  isError: false,
  value: {
    kind: 'foreground', cwd: scratch, exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text: ['[INFO] booting', '[WARN] deprecated', ...Array.from({ length: 200 }, (_, i) => `DEBUG frame ${i}`), 'AssertionError: expected 2 got 3', 'at Test.fn (test.js:12:5)', 'FAILED test_math.py::test_add'].join('\n'), truncated: false },
    stderr: { text: '[ERROR] 1 failed, 199 passed', truncated: false },
  },
}
console.log('\n-- dehydrator, failing run:')
console.log((await dehydrate(shellExec('pytest'), resultFail, async () => ({ kind: 'accept' }))).content[0].text)

console.log('\n-- dehydrator, short non-verification output (must pass through):')
console.log('   ', JSON.stringify(await dehydrate(shellExec('git status'), { isError: false, value: { ...resultPass.value, stdout: { text: 'clean', truncated: false } } }, async () => ({ kind: 'accept' }))))

// ---------------------------------------------------- per-session breaker
console.log('\n-- per session: sA was switched off, sB never was')
const beforeA = nextCalled.count
await breaker(shellExec('npm test', 'sA'), next)
expect('the breaker lets sA through', nextCalled.count - beforeA === 1)
const beforeB = nextCalled.count
await breaker(shellExec('npm test', 'sB'), next)
expect('the breaker still fakes the same command in sB', nextCalled.count - beforeB === 0)
const beforeNone = nextCalled.count
await breaker(shellExec('npm test'), next)
expect('a call with no session follows the default (on)', nextCalled.count - beforeNone === 0)

console.log('\n@ state file:', api.STATE_FILE)

// ------------------------------------------------------- mid-turn lock
// The composer disables the button while a turn runs; the route has to hold the
// same rule, because it is only a URL.
const agentStatus = handlers['agent/status'][0]
agentStatus({ agent: { session: { id: 'sC' } }, status: 'running' })
const busy = await call('/nitro/toggle', { sessionId: 'sC', enabled: false })
expect('a running session refuses the toggle', busy.status === 409 && busy.body.ok === false, `status=${busy.status}`)
expect('the refusal names the reason', busy.body.reason === 'session-busy')
expect('the refusal leaves the switch untouched', busy.body.enabled === true)
expect('state reports that session as running', (await call('/nitro/state?session=sC')).body.running === true)

agentStatus({ agent: { session: { id: 'sC' } }, status: 'idle' })
const idle = await call('/nitro/toggle', { sessionId: 'sC', enabled: false })
expect('the same toggle is accepted once the turn ended', idle.status === 200 && idle.body.enabled === false)
expect('other sessions are not running', api.sessionRunning('sA') === false)

// ------------------------------------------------------- v1 file migration
fs.writeFileSync(api.STATE_FILE, JSON.stringify({ enabled: false }, null, 2), 'utf8')
const migrated = api.readState()
expect('a v1 global switch becomes the default', migrated.default === false && Object.keys(migrated.sessions).length === 0)
expect('the migrated default governs an untouched session', (await call('/nitro/state?session=sD')).body.enabled === false)

// --------------------------------------------------------- hot reload
// The composer button and a hand edit of nitro.json write the same file.
const hotBreaker = handlers['tools/execute'][0]
fs.writeFileSync(api.STATE_FILE, JSON.stringify({ default: true, sessions: {} }, null, 2), 'utf8')
const hot = await hotBreaker(shellExec('npm test', 'sE'), async () => 'REAL-RUN')
expect('an external rewrite is picked up without a remount', hot !== 'REAL-RUN')

// Size changes with the content, so the mtime resolution cannot hide the edit.
fs.writeFileSync(api.STATE_FILE, JSON.stringify({ default: true, sessions: { sE: false }, pad: 'x' }, null, 2), 'utf8')
const hotOff = await hotBreaker(shellExec('npm test', 'sE'), async () => 'REAL-RUN')
expect('a per-session override in the file wins over the default', hotOff === 'REAL-RUN')

// --------------------------------------------------- prompt section per session
const sectionText = sections[0].text
expect('the prompt section is empty for the session that is off', sectionText({ id: 'sE' }) === '')
expect('the prompt section is present for a session that is on', sectionText({ id: 'sX' }).includes('fast delivery mode'))
expect('the prompt section resolves a bare id too', sectionText('sE') === '')

fs.rmSync(scratch, { recursive: true, force: true })
fs.rmSync(stateHome, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
console.log('PLUGIN PROBE ' + (failures === 0 ? 'OK' : 'FAILED'))


