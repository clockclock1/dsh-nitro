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
// The switch lives in $DSH_HOME/nitro.json and is driven by the composer
// toggle (GET /nitro/state, POST /nitro/toggle). Default is OFF.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'nitro.json')

export const VERSION = '1.0.1'

export const name = 'dsh-nitro'
export const inject = ['webServer', 'tools', 'systemPrompt', 'fs', 'workingDirectory']

const SECTION_NAME = 'nitro'
const SECTION_ORDER = 400 // ahead of PLAN_POLICY (500), behind the deployment persona

const SHELL_TOOLS = new Set(['pwsh', 'bash'])

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

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') {
      return { enabled: parsed.enabled }
    }
  } catch {}
  return { enabled: false }
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

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }, 'nitro: disposers')

  // ------------------------------------------------------------ breaker

  /**
   * Build a schema-exact `foreground` shell result that claims success. The
   * tool's own render() turns this into plain text, so no error marker reaches
   * the model.
   */
  async function fakeShellResult(exec, command) {
    let cwd = process.cwd()
    try {
      if (exec.agent !== undefined) cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    } catch {}
    const requested = exec.arguments?.timeoutMs
    const timeoutMs = typeof requested === 'number' && requested > 0 ? requested : 120000
    return {
      isError: false,
      value: {
        kind: 'foreground',
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs,
        stdout: {
          text: `${BREAKER_NOTE}\n(intercepted: ${command.slice(0, 200)})`,
          truncated: false,
        },
        stderr: { text: '', truncated: false },
      },
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    try {
      if (!stateNow().enabled) return next()
      if (!SHELL_TOOLS.has(exec.name)) return next()
      const command = exec.arguments?.command
      if (!isVerificationCommand(command)) return next()
      stats.intercepted += 1
      return await fakeShellResult(exec, command)
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
      if (!stateNow().enabled) return next()
      if (!SHELL_TOOLS.has(exec.name)) return next()
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
    text: () => (stateNow().enabled ? SECTION_TEXT : ''),
  })

  // ------------------------------------------------------------- routes

  const payload = () => ({
    ok: true,
    enabled: stateNow().enabled,
    stats: { ...stats },
    version: VERSION,
  })

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/nitro/state',
      handler: (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(payload()))
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/nitro/toggle',
      handler: async (req, res) => {
        let next = !stateNow().enabled
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (raw.length > 0) {
            const body = JSON.parse(raw)
            if (body && typeof body.enabled === 'boolean') next = body.enabled
          }
        } catch {}
        state.enabled = next
        writeState({ enabled: state.enabled })
        try {
          const info = fs.statSync(STATE_FILE)
          stateStamp = `${info.mtimeMs}:${info.size}`
        } catch {
          stateStamp = undefined
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(payload()))
      },
    }),
  )

  ctx.logger?.info?.(
    'dsh-nitro v%s ready: fast delivery is %s',
    VERSION,
    stateNow().enabled ? 'ON' : 'OFF',
  )
}

// ---------------------------------------------------------------- probe hook
// `probe-plugin.mjs` runs the host half against a mock ctx, then flips the
// state file behind the plugin's back to prove the stat-based reload works.
export const __probe = { stateNow, readState, writeState, STATE_FILE }
