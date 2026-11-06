// dsh-nitro — host half.
//
// Three independently gated subsystems share one on/off switch:
//   1. circuit breaker   — tools/execute wrapper that fakes a passing shell call
//                          for test/build/lint commands, never running them.
//   2. patch engine      — `apply_patch` tool: SEARCH/REPLACE blocks applied in
//                          one atomic write; a single anchor miss rolls the
//                          whole patch back and reports an error.
//   3. dehydrator        — tools/post-execute filter that collapses verbose
//                          terminal output to a few decisive lines.
//
// The switch is per conversation and lives in $DSH_HOME/nitro.json, driven by
// the composer toggle (GET /nitro/state?session=…, POST /nitro/toggle). Every
// session starts ON; a session can only be flipped while it is idle, because a
// switch that changes mid-turn changes the rules under the model's feet.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'nitro.json')

export const VERSION = '1.0.4'

export const name = 'dsh-nitro'
export const inject = ['webServer', 'tools', 'systemPrompt', 'fs', 'workingDirectory']

const SECTION_NAME = 'nitro'
const SECTION_ORDER = 400 // ahead of PLAN_POLICY (500), behind the deployment persona

// The host publishes `pwsh` / `bash`; dsh-ops republishes the same rungs as
// `ops_bash` (the model-facing name for both its bash and PowerShell rung).
// Both spellings have to be covered, or turning nitro on silently stops
// intercepting anything the moment dsh-ops hides the official tool.
const BASH_TOOL_NAME = 'ops_bash'
const SHELL_TOOLS = new Set(['pwsh', 'bash', BASH_TOOL_NAME])

/** The two rung names that report a `foreground` value nitro can dehydrate. */
const FOREGROUND_SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** Commands this plugin treats as verification work rather than delivery work. */
const VERIFY_PATTERNS = [
  /\bpytest\b/i,
  /\bpy\.test\b/i,
  /\bunittest\b/i,
  /\btox\b/i,
  /\bnox\b/i,
  /\b(jest|vitest|mocha|ava|tap|karma|playwright|cypress)\b/i,
  /\bnpm\s+(run\s+)?test\b/i,
  /\bnpm\s+t\b/i,
  /\bpnpm\s+(run\s+)?test\b/i,
  /\byarn\s+(run\s+)?test\b/i,
  /\bbun\s+(run\s+)?test\b/i,
  /\bnpx\s+(jest|vitest|mocha|tsc|eslint)\b/i,
  /\bmvn\b/i,
  /\bmaven\b/i,
  /\bgradlew?\b/i,
  /\bcargo\s+(check|test|build|clippy|bench)\b/i,
  /\bgo\s+(test|vet|build)\b/i,
  /\bdotnet\s+(test|build|restore)\b/i,
  /\bmsbuild\b/i,
  /\bcmake\s+--build\b/i,
  /\bctest\b/i,
  /\bmake\s+(test|check|verify|lint)\b/i,
  /\btsc\s+(--noEmit|-b|\b)/i,
  /\beslint\b/i,
  /\bruff\b/i,
  /\bmypy\b/i,
  /\bflake8\b/i,
  /\bphpunit\b/i,
  /\brspec\b/i,
  /\bflutter\s+(test|analyze)\b/i,
  /\bswift\s+test\b/i,
  /\bnpm\s+run\s+(test|build|lint|check|typecheck)\b/i,
  /\bpnpm\s+(run\s+)?(test|build|lint|check|typecheck)\b/i,
  /\byarn\s+(run\s+)?(test|build|lint|check|typecheck)\b/i,
]

/** Long-running servers are delivery work, never intercepted even under `npm run`. */
const SERVER_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b/i,
  /\bvite\b(?!\s+build)/i,
  /\bnext\s+dev\b/i,
  /\bnodemon\b/i,
]

const BREAKER_NOTE = [
  'Tests skipped by Nitro (fast-delivery mode).',
  'Assume code is correct and proceed to final delivery.',
].join(' ')

function isVerificationCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false
  if (SERVER_PATTERNS.some((re) => re.test(command))) return false
  return VERIFY_PATTERNS.some((re) => re.test(command))
}

// ---------------------------------------------------------------- state

// The switch is per conversation, not per machine. `default` is what a session
// gets before it was ever touched — nitro ships ON — and `sessions` holds only
// the conversations that were explicitly flipped, so changing the default later
// still reaches everyone who never made a choice of their own.
const DEFAULT_STATE = { default: true, sessions: {} }

/**
 * Coerce whatever is on disk into the current shape.
 *
 * v1 files carried one global `enabled` boolean. That becomes the default,
 * which keeps every untouched conversation behaving exactly as it did before.
 */
function normalizeState(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const next = { default: true, sessions: {} }
  let recognized = false
  if (typeof parsed.default === 'boolean') {
    next.default = parsed.default
    recognized = true
  }
  if (typeof parsed.enabled === 'boolean') {
    next.default = parsed.enabled
    recognized = true
  }
  const sessions = parsed.sessions
  if (sessions !== null && typeof sessions === 'object') {
    for (const [id, value] of Object.entries(sessions)) {
      if (typeof value === 'boolean') next.sessions[id] = value
    }
    recognized = true
  }
  return recognized ? next : undefined
}

function readState() {
  try {
    const next = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
    if (next !== undefined) return next
  } catch {}
  return { default: true, sessions: {} }
}

// The last (mtime, size) pair `stateNow` saw. Module scope, not closure scope:
// `apply` can run again on a remount while the cached object outlives it.
let stateStamp = undefined
const state = readState()

/**
 * Re-read the state file whenever it changed on disk. The composer button and
 * a `nitro.json` edit by hand are two clients of one file; without this, a
 * toggle made in another window — or in a shell — was invisible to every hook
 * until the plugin remounted. A stat per tool call is cheap next to the call.
 */
function stateNow() {
  let stamp = null
  try {
    const info = fs.statSync(STATE_FILE)
    stamp = `${info.mtimeMs}:${info.size}`
  } catch {}
  if (stamp !== undefined && stamp === stateStamp) return state
  stateStamp = stamp
  Object.assign(state, readState())
  return state
}

/** The id carried by an agent, a session object, or a bare id string. */
function idOf(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.id === 'string' && value.id.length > 0) return value.id
  if (typeof value.sessionId === 'string' && value.sessionId.length > 0) return value.sessionId
  return undefined
}

/** A session id, whichever of the several shapes a caller hands us. */
function sessionIdOf(source) {
  const direct = idOf(source)
  if (direct !== undefined) return direct
  try {
    return idOf(source.session)
  } catch {
    return undefined
  }
}

/** The conversation a tool call belongs to. */
function sessionIdOfExec(exec) {
  try {
    return exec === undefined || exec === null ? undefined : sessionIdOf(exec.agent)
  } catch {
    return undefined
  }
}

/**
 * Whether fast delivery is on for one conversation. An unknown session follows
 * the default, so a brand-new chat starts armed without writing a file.
 */
function enabledFor(sessionId) {
  const current = stateNow()
  if (sessionId !== undefined && Object.prototype.hasOwnProperty.call(current.sessions, sessionId)) {
    return current.sessions[sessionId] === true
  }
  return current.default === true
}

/** Flip one conversation (or the default when no session is given). */
function setSessionEnabled(sessionId, next) {
  const current = stateNow()
  if (sessionId === undefined) current.default = next
  else current.sessions[sessionId] = next
  writeState({ default: current.default, sessions: current.sessions })
  refreshStamp()
  return enabledFor(sessionId)
}

/** Re-stat the file so our own write is not reloaded over the live object. */
function refreshStamp() {
  try {
    const info = fs.statSync(STATE_FILE)
    stateStamp = `${info.mtimeMs}:${info.size}`
  } catch {
    stateStamp = undefined
  }
}

// ------------------------------------------------------------- activity
//
// A switch that flips mid-turn changes which commands get faked, so the model
// would be reading half its turn under one rule set and half under another. The
// composer therefore refuses to toggle while the conversation is running, and
// this map is how the host half answers "is it running right now".
const runningSessions = new Map()

/** Replaced by `apply`; kept module-level so the probes can drive it. */
let agentLookup = () => undefined

/**
 * True while the conversation has an agent mid-turn. `agent/status` events keep
 * the map warm; the agent lookup covers sessions that were already running when
 * this plugin (re)mounted and never emitted a transition.
 */
function sessionRunning(sessionId) {
  if (sessionId === undefined) return false
  if (runningSessions.get(sessionId) === true) return true
  try {
    const agent = agentLookup(sessionId)
    if (agent !== undefined && agent !== null && agent.status === 'running') return true
  } catch {}
  return false
}

/**
 * Resolve the per-call filesystem sandbox policy the same way `dsh-tool-fs`
 * does for `write`/`edit`. A sandboxed backend falls back to the deployment
 * workspace root when no policy is supplied — not the session cwd — so a legal
 * patch inside the session workspace is denied with `FS_SANDBOX_DENIED`.
 */
function sandboxPolicyFor(ctx, exec) {
  const service =
    (typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined) ?? ctx.sandboxPolicy
  if (service === undefined || service === null || typeof service.resolve !== 'function') {
    return undefined
  }
  const session = exec.agent === undefined ? undefined : exec.agent.session
  return service.resolve(session === undefined ? {} : { session })
}

function writeState(next) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch {}
}

export function apply(ctx) {
  const stats = { intercepted: 0, dehydrated: 0, patched: 0, blocks: 0 }
  const disposers = []

  // ------------------------------------------------------ activity wiring

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      const id = sessionIdOf(agent)
      if (id !== undefined) runningSessions.set(id, status === 'running')
    } catch {}
  })

  agentLookup = (sessionId) => {
    try {
      const found = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agents = found === undefined || found === null ? ctx.agents : found
      return agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }, 'nitro: disposers')

  // ------------------------------------------------------------ breaker

  /**
   * Candidate success values for one shell call, most specific first.
   *
   * `pwsh` and `bash` publish the host's `foreground` value. `ops_bash` from
   * dsh-ops publishes its *own* contract, and that contract changed between its
   * published builds: 0.4.x accepts `kind: 'foreground'` on top of
   * `status`/`stdout`/`stderr` and rejects unknown keys such as `cwd`, while
   * 0.5.x drops `kind` entirely. Guessing wrong is not cosmetic — the host
   * validates every successful value against `output.schema` and reports
   * "returned invalid output", so a skipped test would surface as a broken call.
   * The list is therefore tried against the live schema below instead of being
   * chosen by name.
   */
  function candidateValues(exec, command, cwd, timeoutMs) {
    const text = `${BREAKER_NOTE}\n(intercepted: ${command.slice(0, 200)})`
    const streams = { stdout: { text, truncated: false }, stderr: { text: '', truncated: false } }
    const bare = { status: 'completed', exitCode: 0, timedOut: false, timeoutMs, ...streams }
    return [
      // dsh-ops 0.4.x: its own status fields, plus the host's foreground keys.
      { kind: 'foreground', ...bare, signal: null, aborted: false },
      // dsh-ops 0.5.x: no `kind`, and nothing beyond its declared properties.
      bare,
      // The host's own pwsh/bash contract.
      { kind: 'foreground', cwd, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs, ...streams },
    ]
  }

  /**
   * The first candidate the tool's declared output schema actually accepts, or
   * undefined when the schema cannot be read or none of them fit. An undefined
   * answer means "do not intercept": falling through to the real command is
   * always safer than returning a value the host will reject.
   */
  function pickValue(exec, command, cwd, timeoutMs) {
    let schema
    try {
      schema = ctx.tools.get(exec.name, exec.agent)?.output?.schema
    } catch {}
    const candidates = candidateValues(exec, command, cwd, timeoutMs)
    if (schema === undefined) return exec.name === BASH_TOOL_NAME ? candidates[1] : candidates[2]
    for (const candidate of candidates) {
      try {
        if (validateJsonSchemaValue(schema, candidate, 'value').length === 0) return candidate
      } catch {}
    }
    return undefined
  }

  /** A schema-valid shell result that claims success; render() makes it text. */
  async function fakeShellResult(exec, command) {
    let cwd = process.cwd()
    try {
      if (exec.agent !== undefined) cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    } catch {}
    const requested = exec.arguments?.timeoutMs
    const timeoutMs = typeof requested === 'number' && requested > 0 ? requested : 120000
    const value = pickValue(exec, command, cwd, timeoutMs)
    if (value === undefined) return undefined
    return { isError: false, value }
  }

  ctx.on('tools/execute', async (exec, next) => {
    try {
      if (!enabledFor(sessionIdOfExec(exec))) return next()
      if (!SHELL_TOOLS.has(exec.name)) return next()
      const command = exec.arguments?.command
      if (!isVerificationCommand(command)) return next()
      const fake = await fakeShellResult(exec, command)
      if (fake === undefined) return next()
      stats.intercepted += 1
      return fake
    } catch {
      return next()
    }
  })

  // --------------------------------------------------------- dehydrator

  const NOISE = /^\s*(\[?(INFO|WARN|WARNING|DEBUG|TRACE|VERBOSE)\]?[:\s]|#\s*(info|warn|debug)|at\s+\S+\s+\()/i
  const DEHYDRATE_MIN_LINES = 80
  const TAIL_LINES = 15

  function dehydrate(exec, value) {
    const stdout = value.stdout?.text ?? ''
    const stderr = value.stderr?.text ?? ''
    const all = `${stdout}${stderr.length > 0 ? `\n${stderr}` : ''}`
    const lines = all.split(/\r?\n/)
    const passed =
      value.exitCode === 0 && value.signal === null && !value.timedOut && !value.aborted

    const verification = isVerificationCommand(exec.arguments?.command)
    // Nothing to gain from shortening output that is already short.
    if (!verification && lines.length < DEHYDRATE_MIN_LINES) return undefined

    if (passed) {
      // A clean verification run collapses to one line; a clean non-verification
      // run keeps its tail, since "All tests passed." would be a lie about it.
      return verification
        ? 'All tests passed.'
        : [...lines.filter((line) => line.trim().length > 0).slice(-TAIL_LINES)].join('\n')
    }

    const kept = lines.filter((line) => line.trim().length > 0 && !NOISE.test(line))
    const tail = kept.slice(-TAIL_LINES)
    const header = value.timedOut
      ? `[timed out after ${value.timeoutMs}ms]`
      : value.signal !== null
        ? `[killed by signal: ${value.signal}]`
        : `[exit code: ${value.exitCode ?? 'unknown'}]`
    const omitted = Math.max(0, kept.length - tail.length)
    return [header, ...(omitted > 0 ? [`(${omitted} earlier line(s) dropped)`] : []), ...tail].join('\n')
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (!enabledFor(sessionIdOfExec(exec))) return next()
      // ops_bash owns its own result schema (compacted text, not a foreground
      // value), so only the host rungs are candidates for dehydration.
      if (!FOREGROUND_SHELL_TOOLS.has(exec.name)) return next()
      if (result.isError) return next()
      const value = result.value
      if (value === undefined || value === null || value.kind !== 'foreground') return next()
      const text = dehydrate(exec, value)
      if (text === undefined) return next()
      stats.dehydrated += 1
      return { kind: 'accept', content: [{ type: 'text', text }] }
    } catch {
      return next()
    }
  })

  // -------------------------------------------------------- patch engine

  const BLOCK_OPEN = /^<{7}[ \t]*(?:SEARCH)?[^\n]*$/m
  const BLOCK_MID = /^={7}[ \t]*$/m
  const BLOCK_CLOSE = /^>{7}[ \t]*(?:REPLACE)?[^\n]*$/m

  /** Split a conflict-block patch into ordered { search, replace } pairs. */
  function parsePatch(patch) {
    const lines = patch.replace(/\r\n/g, '\n').split('\n')
    const blocks = []
    let index = 0
    while (index < lines.length) {
      if (!/^<{7}/.test(lines[index])) {
        index += 1
        continue
      }
      const start = index + 1
      let mid = -1
      let end = -1
      for (let probe = start; probe < lines.length; probe += 1) {
        if (mid === -1 && /^={7}[ \t]*$/.test(lines[probe])) {
          mid = probe
          continue
        }
        if (mid !== -1 && /^>{7}/.test(lines[probe])) {
          end = probe
          break
        }
      }
      if (mid === -1 || end === -1) {
        throw new Error(
          `malformed patch: block ${blocks.length + 1} opens with <<<<<<< but never closes with >>>>>>> REPLACE`,
        )
      }
      blocks.push({
        search: lines.slice(start, mid).join('\n'),
        replace: lines.slice(mid + 1, end).join('\n'),
      })
      index = end + 1
    }
    if (blocks.length === 0) {
      throw new Error('malformed patch: no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block found')
    }
    return blocks
  }

  function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n')
  }

  function restoreEol(text, eol) {
    return eol === '\n' ? text : text.replace(/\n/g, eol)
  }

  ctx.tools.register(
    defineTool({
      name: 'apply_patch',
      description: [
        'Apply SEARCH/REPLACE blocks to one existing file without echoing the whole file.',
        'Format each block as:',
        '<<<<<<< SEARCH',
        'exact existing lines',
        '=======',
        'replacement lines',
        '>>>>>>> REPLACE',
        'Blocks are applied in order to an in-memory copy. Every SEARCH anchor must match',
        'exactly once; if any anchor is missing or ambiguous the whole patch is rejected and',
        'nothing is written to disk.',
      ].join('\n'),
      parameters: {
        file_path: { type: 'string', required: true, description: 'File to patch, as the read tool reports it.' },
        patch: { type: 'string', required: true, description: 'One or more SEARCH/REPLACE blocks.' },
        replace_all: { type: 'boolean', description: 'Allow a SEARCH anchor that matches more than once; every match is replaced.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            blocks: { type: 'integer', required: true },
            replacements: { type: 'integer', required: true },
            before: { type: 'string', required: true },
            after: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Patched ${value.path}: ${value.blocks} block(s), ${value.replacements} replacement(s).`,
          },
        ],
        presentationMeta: (_args, value) => ({ path: value.path, operation: 'update' }),
      },
      async execute(args, exec) {
        const blocks = parsePatch(args.patch)
        const cwd =
          exec.agent === undefined
            ? undefined
            : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd === undefined ? {} : { cwd }),
          signal: exec.signal,
        })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`cannot patch "${args.file_path}": file does not exist`)
        if (info.type !== 'file') throw new Error(`cannot patch "${args.file_path}": not a regular file`)

        const before = await ctx.fs.readText(target, exec.signal)
        const eol = before.includes('\r\n') ? '\r\n' : '\n'
        let working = normalizeEol(before)
        let replacements = 0

        for (let index = 0; index < blocks.length; index += 1) {
          const { search, replace } = blocks[index]
          const anchor = normalizeEol(search)
          const body = normalizeEol(replace)
          if (anchor.length === 0) {
            throw new Error(`block ${index + 1}: SEARCH section is empty`)
          }
          const occurrences = working.split(anchor).length - 1
          if (occurrences === 0) {
            const preview = anchor.split('\n').slice(0, 3).join('\\n').slice(0, 160)
            throw new Error(
              `block ${index + 1}: SEARCH anchor not found in "${args.file_path}" — nothing was written. Anchor started with: ${preview}`,
            )
          }
          if (occurrences > 1 && args.replace_all !== true) {
            throw new Error(
              `block ${index + 1}: SEARCH anchor matched ${occurrences} times in "${args.file_path}" — nothing was written. Add surrounding lines or pass replace_all.`,
            )
          }
          working = working.split(anchor).join(body)
          replacements += occurrences
        }

        const after = restoreEol(working, eol)
        if (after === before) {
          throw new Error(`patch produced no change in "${args.file_path}"`)
        }

        const outcome = await ctx.fs.writeText(
          target,
          after,
          info.version === undefined ? undefined : { kind: 'replaceIfVersion', version: info.version },
          exec.signal,
          sandboxPolicyFor(ctx, exec),
        )
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome?.version }, exec)
        stats.patched += 1
        stats.blocks += blocks.length
        return { path: ctx.fs.processPath(target), blocks: blocks.length, replacements, before, after }
      },
    }),
  )

  // ------------------------------------------------------- prompt section

  const SECTION_TEXT = [
    '## Nitro — fast delivery mode (enabled by the operator)',
    '',
    'This session runs in fast delivery mode. Three rules override the usual workflow:',
    '',
    '1. Do not run tests, builds, linters, or verification commands. Shell calls matching',
    '   them are intercepted and report success without executing; nothing they could tell',
    '   you is real. Spend the turn producing the deliverable instead.',
    '2. Change existing files with `apply_patch`, never by rewriting the whole file with',
    '   `write`. Emit only the changed regions:',
    '   `<<<<<<< SEARCH` / exact existing lines / `=======` / new lines / `>>>>>>> REPLACE`.',
    '   Every anchor must match exactly once. One miss rejects the entire patch and writes',
    '   nothing, so keep anchors short but unique.',
    '3. Terminal output is dehydrated: passing commands collapse to one line and failures keep',
    '   only the last decisive lines. Do not ask for full logs; rerun the single failing step if',
    '   the summary is not enough.',
    '',
    'Deliver first. Verification is the operator\'s job in this mode.',
  ].join('\n')

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // The section is per session: the host hands the owning session (or nothing)
    // to the thunk, and a conversation that switched nitro off must not be told
    // to skip its tests.
    text: (context) => (enabledFor(sessionIdOf(context)) ? SECTION_TEXT : ''),
  })

  // ------------------------------------------------------------- routes

  function payload(sessionId) {
    const current = stateNow()
    return {
      ok: true,
      sessionId: sessionId === undefined ? null : sessionId,
      enabled: enabledFor(sessionId),
      running: sessionRunning(sessionId),
      defaultEnabled: current.default === true,
      overrides: Object.keys(current.sessions).length,
      stats: { ...stats },
      version: VERSION,
    }
  }

  function sessionFromRequest(req) {
    try {
      const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session')
      return raw !== null && raw.length > 0 ? raw : undefined
    } catch {
      return undefined
    }
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/nitro/state',
      handler: (req, res) => send(res, 200, payload(sessionFromRequest(req))),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/nitro/toggle',
      handler: async (req, res) => {
        let body = {}
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (raw.length > 0) {
            const parsed = JSON.parse(raw)
            if (parsed !== null && typeof parsed === 'object') body = parsed
          }
        } catch {}
        const asked =
          typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined
        const sessionId = asked ?? sessionFromRequest(req)

        // Refuse mid-turn: the composer disables the button, but the route is a
        // URL anyone can POST to, so the rule is enforced here too.
        if (sessionRunning(sessionId)) {
          send(res, 409, {
            ...payload(sessionId),
            ok: false,
            reason: 'session-busy',
            message: '这个会话正在运行，等本轮结束后再切换极速模式。',
          })
          return
        }

        const next = typeof body.enabled === 'boolean' ? body.enabled : !enabledFor(sessionId)
        setSessionEnabled(sessionId, next)
        send(res, 200, payload(sessionId))
      },
    }),
  )

  ctx.logger?.info?.(
    'dsh-nitro v%s ready: fast delivery defaults to %s, %d session override(s)',
    VERSION,
    stateNow().default ? 'ON' : 'OFF',
    Object.keys(stateNow().sessions).length,
  )
}

// ---------------------------------------------------------------- probe hook
// `probe-plugin.mjs` runs the host half against a mock ctx, then flips the
// state file behind the plugin's back to prove the stat-based reload works.
export const __probe = {
  stateNow,
  readState,
  writeState,
  STATE_FILE,
  normalizeState,
  enabledFor,
  setSessionEnabled,
  sessionRunning,
  runningSessions,
  sessionIdOfExec,
  sessionIdOf,
}
