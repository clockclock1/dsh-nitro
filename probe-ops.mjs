// Does the breaker emit a value the *real* `ops_bash` output schema accepts?
//
// dsh-ops publishes its own contract for the shell rung, and that contract is not
// the host's `foreground` value: it adds `status`, drops `cwd`, and (in the 0.4.x
// builds) also carries `kind: 'foreground'`. The host validates every successful
// value against `output.schema`, so a near-miss here is not cosmetic — it turns a
// skipped test into "returned invalid output".
//
// The two fixtures below are transcribed from dsh-ops itself:
//   0.4.x  lib/shells/host-contract.js  HOST_BASH_OUTPUT_SCHEMA (foreground arm)
//   0.5.x  src/shells/tool.ts           BASH_OUTPUT_SCHEMA
// Transcribing beats depending on a checkout, and either fixture failing is what
// this probe exists to catch.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OPS_04 = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId', 'label'], properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' }, label: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId', 'label', 'timeoutMs', 'output'], properties: { kind: { type: 'string', const: 'promoted' }, jobId: { type: 'string' }, label: { type: 'string' }, timeoutMs: { type: 'number' }, output: { type: 'string' } } },
    { ...OPS_05(), required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr', 'kind', 'exitCode', 'signal', 'aborted'], properties: { ...OPS_05().properties, kind: { type: 'string', const: 'foreground' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, signal: { oneOf: [{ type: 'string' }, { type: 'null' }] }, aborted: { type: 'boolean' } } },
  ],
}

function OPS_05() {
  const stream = {
    type: 'object', additionalProperties: false, required: ['text', 'truncated'],
    properties: { text: { type: 'string' }, truncated: { type: 'boolean' }, bytes: { type: 'integer' }, bytesTotal: { type: 'integer' }, lines: { type: 'integer' }, spillPath: { type: 'string' } },
  }
  return {
    type: 'object', additionalProperties: false,
    required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed'] }, exitCode: { type: 'integer' }, signal: { type: 'string' },
      error: { type: 'string' }, permission: { type: 'object' }, restriction: { type: 'object' }, sandbox: { type: 'object' },
      cancelled: { type: 'boolean' }, diagnostics: { type: 'object' }, timedOut: { type: 'boolean' }, timeoutMs: { type: 'number' },
      stdout: stream, stderr: stream,
    },
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-ops-'))
process.env.DSH_HOME = scratch
fs.writeFileSync(path.join(scratch, 'nitro.json'), JSON.stringify({ enabled: true }), 'utf8')

const handlers = { 'tools/execute': [], 'tools/post-execute': [] }
const schemas = new Map()
const ctx = {
  tools: {
    register() { return () => {} },
    get(name) { const schema = schemas.get(name); return schema === undefined ? undefined : { output: { schema } } },
  },
  on(event, handler) { handlers[event]?.push(handler) },
  effect(fn) { const dispose = fn(); return () => dispose?.() },
  emit() {},
  waterfall: async (_name, ...rest) => rest[rest.length - 1](),
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  systemPrompt: { section() {}, getSectionOrder: () => 0, context() {}, tools() {} },
  fs: {},
  workingDirectory: { async ensure() { return scratch } },
  webServer: { register() { return () => {} } },
  get() { return undefined },
}

const plugin = await import(new URL('./lib/index.js', import.meta.url).href)
plugin.apply(ctx)
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')

const breaker = handlers['tools/execute'][0]
const call = (name) => ({ name, arguments: { command: 'npm test' }, agent: undefined, signal: { aborted: false } })
let realRuns = 0
const next = async () => { realRuns += 1; return 'REAL-RUN' }
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const [label, schema] of [['dsh-ops 0.4.x', OPS_04], ['dsh-ops 0.5.x', OPS_05()]]) {
  schemas.set('ops_bash', schema)
  const before = realRuns
  const out = await breaker(call('ops_bash'), next)
  const intercepted = realRuns === before
  const problems = intercepted ? validateJsonSchemaValue(schema, out.value, 'value') : ['passed through']
  check(`ops_bash against ${label}`, intercepted && problems.length === 0, problems[0])
}

schemas.set('ops_bash', { type: 'object', additionalProperties: false, required: ['impossible'], properties: { impossible: { type: 'string' } } })
const beforeImpossible = realRuns
await breaker(call('ops_bash'), next)
check('unsatisfiable schema falls through instead of fabricating', realRuns > beforeImpossible)

schemas.delete('pwsh')
const beforePwsh = realRuns
const pwshOut = await breaker(call('pwsh'), next)
check('pwsh still intercepted with no schema registered', realRuns === beforePwsh && pwshOut?.value?.kind === 'foreground')

const dehydrate = handlers['tools/post-execute'][0]
const bigResult = (name) => ({
  isError: false,
  value: {
    kind: 'foreground', cwd: scratch, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'), truncated: false },
    stderr: { text: '', truncated: false },
  },
})
const opsDecision = await dehydrate({ ...call('ops_bash') }, bigResult('ops_bash'), async () => ({ kind: 'accept' }))
check('dehydrator leaves ops_bash alone', opsDecision.kind === 'accept' && opsDecision.content === undefined)
const pwshDecision = await dehydrate({ ...call('pwsh') }, bigResult('pwsh'), async () => ({ kind: 'accept' }))
check('dehydrator still rewrites pwsh', typeof pwshDecision.content?.[0]?.text === 'string')

fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nOPS COMPAT OK' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
