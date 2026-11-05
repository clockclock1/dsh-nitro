// End-to-end smoke test of dsh-nitro's host half against a mock ctx.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-'))
const file = path.join(scratch, 'sample.txt')
fs.writeFileSync(file, 'line one\nline two\nline three\nline four\n', 'utf8')

const registered = []
const handlers = { 'tools/execute': [], 'tools/post-execute': [] }
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

// ---- toggle on through the route
const state = { enabled: false }
const call = async (p, body) => {
  const chunks = []
  let status = 0
  const req = {
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
  await routes.get(p)(req, res)
  return { status, body: JSON.parse(chunks.join('')) }
}

console.log('\n-- GET /nitro/state:', JSON.stringify(await call('/nitro/state')))
console.log('-- POST /nitro/toggle:', JSON.stringify(await call('/nitro/toggle')))
console.log('-- GET again:', JSON.stringify(await call('/nitro/state')))
console.log('-- POST re-arm {enabled:true}:', JSON.stringify(await call('/nitro/toggle', { enabled: true })))

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

const shellExec = (command) => ({ name: 'pwsh', arguments: { command, description: 'x' }, agent: undefined, signal: { aborted: false } })

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

const dehydrate = handlers['tools/post-execute'][0]
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

console.log('\n@ state file:', fs.existsSync(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'nitro.json')))

console.log('-- reset to default OFF:', JSON.stringify(await call('/nitro/toggle', { enabled: false })))

fs.rmSync(scratch, { recursive: true, force: true })
