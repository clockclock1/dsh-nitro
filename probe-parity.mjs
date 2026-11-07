// Diffs the plugin's built-in schema helpers against the host's
// `@deepseek-ai/dsh-tools`, on the schemas this plugin actually meets.
//
// Why this exists: the plugin used to declare `@deepseek-ai/dsh-tools` as a
// runtime dependency, which installs a second copy of a host package next to the
// host's own copy. The plugin now ships its own small shims. This probe proves
// the replacement is safe in the only direction that matters:
//
//   A. Never looser. If the shim accepts a value, the host must accept it too.
//      A shim that accepts a value the host rejects would fabricate a tool
//      result the host then throws on.
//   B. Not tighter than needed on real contracts. For the schemas this plugin
//      actually encounters (dsh-ops 0.4.x / 0.5.x, the host pwsh contract,
//      apply_patch's own output) the shim must reach the same verdict as the
//      host — anything else silently disables interception.
//
// Where the host ignores a constraint (`pattern`, `anyOf`, `minItems`, unknown
// keywords), the shim is deliberately stricter. That is a documented
// degradation, not a bug: the session falls back to running the real command.
//
// Run: node probe-parity.mjs   (needs the devDependency installed)

import { __probe } from './lib/index.js'
import { validateJsonSchemaValue as hostValidate } from '@deepseek-ai/dsh-tools'

const shimValidate = __probe.validateJsonSchemaValue
const shimLift = __probe.liftRequired

const streams = {
  stdout: { text: 'All tests passed.', truncated: false, bytes: 20, bytesTotal: 20, lines: 1 },
  stderr: { text: '', truncated: false, bytes: 0, bytesTotal: 0, lines: 0 },
}

const nullableInt = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

// dsh-ops 0.4.x: three-way oneOf, the foreground branch needs kind/exitCode/signal/aborted.
const OPS_04 = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'jobId', 'label'],
      properties: {
        kind: { const: 'background' },
        jobId: { type: 'string' },
        label: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'jobId', 'label', 'timeoutMs', 'output'],
      properties: {
        kind: { const: 'promoted' },
        jobId: { type: 'string' },
        label: { type: 'string' },
        timeoutMs: { type: 'integer' },
        output: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr', 'kind', 'exitCode', 'signal', 'aborted'],
      properties: {
        kind: { const: 'foreground' },
        status: { enum: ['completed', 'failed'] },
        exitCode: nullableInt,
        signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        aborted: { type: 'boolean' },
        timedOut: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
        stdout: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        stderr: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      },
    },
  ],
}

// dsh-ops 0.5.x: no `kind`, nothing beyond the declared properties.
const OPS_05 = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    status: { enum: ['completed', 'failed'] },
    exitCode: nullableInt,
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'integer' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        bytes: { type: 'integer' },
        bytesTotal: { type: 'integer' },
        lines: { type: 'integer' },
        spillPath: { type: 'string' },
      },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        bytes: { type: 'integer' },
        bytesTotal: { type: 'integer' },
        lines: { type: 'integer' },
        spillPath: { type: 'string' },
      },
    },
  },
}

// The host's own pwsh/bash contract.
const HOST_SHELL = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    kind: { const: 'foreground' },
    cwd: { type: 'string' },
    exitCode: nullableInt,
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    timeoutMs: { type: 'integer' },
    stdout: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    stderr: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  },
}

// apply_patch's own output schema, written in the plugin's `required: true`
// shorthand exactly as it appears in the source. The host lifts that shorthand
// inside `defineTool` before validating, so both sides get the lifted form.
const APPLY_PATCH_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    blocks: { type: 'integer', required: true },
    replacements: { type: 'integer', required: true },
    before: { type: 'string', required: true },
    after: { type: 'string', required: true },
  },
}

const opsForeground = {
  kind: 'foreground',
  status: 'completed',
  exitCode: 0,
  signal: null,
  aborted: false,
  timedOut: false,
  timeoutMs: 120000,
  ...streams,
}

const opsBare = {
  status: 'completed',
  exitCode: 0,
  timedOut: false,
  timeoutMs: 120000,
  ...streams,
}

const hostForeground = {
  kind: 'foreground',
  cwd: 'D:\\code\\work',
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 120000,
  ...streams,
}

// expect: 'both-accept' | 'both-reject' | 'shim-stricter'
const cases = [
  ['ops 0.4.x accepts its foreground shape', OPS_04, opsForeground, 'both-accept'],
  ['ops 0.4.x rejects the bare shape', OPS_04, opsBare, 'both-reject'],
  ['ops 0.4.x rejects a stray cwd', OPS_04, { ...opsForeground, cwd: 'x' }, 'both-reject'],
  ['ops 0.4.x rejects a missing status', OPS_04, { ...opsForeground, status: undefined }, 'both-reject'],
  ['ops 0.4.x rejects exitCode as a string', OPS_04, { ...opsForeground, exitCode: '0' }, 'both-reject'],
  ['ops 0.5.x rejects the host foreground shape', OPS_05, hostForeground, 'both-reject'],
  ['ops 0.5.x accepts the bare shape', OPS_05, opsBare, 'both-accept'],
  ['ops 0.5.x rejects a truncated-less stream', OPS_05, { ...opsBare, stdout: { text: 'x' } }, 'both-reject'],
  ['host shell accepts its foreground shape', HOST_SHELL, hostForeground, 'both-accept'],
  ['host shell rejects the bare shape', HOST_SHELL, opsBare, 'both-reject'],
  ['host shell rejects a null cwd', HOST_SHELL, { ...hostForeground, cwd: null }, 'both-reject'],
  ['apply_patch accepts its own result', APPLY_PATCH_SPEC, { path: 'a.txt', blocks: 1, replacements: 2, before: '', after: 'x' }, 'both-accept'],
  ['apply_patch rejects a missing after', APPLY_PATCH_SPEC, { path: 'a.txt', blocks: 1, replacements: 2, before: '' }, 'both-reject'],
  ['apply_patch rejects a float block count', APPLY_PATCH_SPEC, { path: 'a.txt', blocks: 1.5, replacements: 2, before: '', after: 'x' }, 'both-reject'],
  ['enum rejects an outsider', { type: 'string', enum: ['a', 'b'] }, 'c', 'both-reject'],
  ['enum accepts a member', { type: 'string', enum: ['a', 'b'] }, 'b', 'both-accept'],
  ['const accepts its value', { type: 'string', const: 'foreground' }, 'foreground', 'both-accept'],
  ['const rejects another value', { type: 'string', const: 'foreground' }, 'background', 'both-reject'],
  ['pattern accepts a match (host ignores pattern)', { type: 'string', pattern: '^npm ' }, 'npm run dev', 'both-accept'],
  ['pattern rejects a miss', { type: 'string', pattern: '^npm ' }, 'node app.js', 'shim-stricter'],
  ['unknown keyword is not guessed', { type: 'object', $ref: '#/x' }, {}, 'shim-stricter'],
  ['type array is refused, not thrown', { type: ['string', 'null'] }, null, 'shim-stricter'],
  ['minItems rejects a short array', { type: 'array', minItems: 2 }, [1], 'shim-stricter'],
  ['anyOf rejects a non-member', { anyOf: [{ type: 'string' }, { type: 'null' }] }, 3, 'shim-stricter'],
  ['anything-constrains-nothing passes', {}, 'whatever', 'both-accept'],
]

const hostVerdict = (schema, value) => {
  try {
    return hostValidate(schema, value, 'value').length === 0
  } catch {
    // The host validator throws on nodes it cannot represent (a `type` array).
    // That is not acceptance, and it is worse than a rejection.
    return 'throws'
  }
}

let bad = 0
let looser = 0

for (const [label, rawSchema, value, expect] of cases) {
  const isSpec = rawSchema === APPLY_PATCH_SPEC
  const schema = isSpec ? shimLift(rawSchema) : rawSchema
  const host = hostVerdict(schema, value)
  const shim = shimValidate(schema, value, 'value').length === 0

  if (shim === true && host !== true) looser += 1

  const ok =
    expect === 'both-accept'
      ? host === true && shim === true
      : expect === 'both-reject'
        ? host === false && shim === false
        : shim === false && host !== false

  if (!ok) bad += 1
  console.log(`${ok ? 'OK  ' : 'BAD '} ${label}\n      host=${String(host)} shim=${shim} expect=${expect}`)
}

console.log('')
if (looser > 0) {
  console.log(`UNSAFE — ${looser} case(s) accepted by the shim but not by the host`)
}
if (bad > 0) {
  console.log(`${bad}/${cases.length} cases missed their expected verdict`)
  process.exit(1)
}
console.log(`PARITY OK — ${cases.length} cases; shim never looser than the host`)
