// dsh-nitro — 一条命令完成发布。
//
//   node publish.mjs             -> npm publish + GitHub release（版本取自 package.json）
//   node publish.mjs --dry-run   -> 只做检查与打包，不写任何远端状态
//
// 需要先登录 npm（`npm login`，或把 NPM_TOKEN 放进环境变量）。GitHub 侧用 `gh auth login`。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { name, version } = manifest
const tag = `v${version}`
const tarball = `${name}-${version}.tgz`

// Windows ships npm/gh/git as .cmd shims, and execFileSync cannot exec a shim
// without a shell. `shell: true` then re-splits the command line on spaces, so
// "C:\Program Files\nodejs\npm.cmd" lands as "C:\Program". Spawning cmd.exe
// explicitly and quoting each argument keeps paths with spaces intact.
const isWindows = process.platform === 'win32'
const quote = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value)

function exec(command, args, opts = {}) {
  const stdio = opts.quiet ? ['ignore', 'pipe', 'pipe'] : dryRun && !opts.alwaysShow ? ['inherit', 'pipe', 'pipe'] : 'inherit'
  if (!opts.quiet) console.log(`\n$ ${[command, ...args].join(' ')}`)
  if (isWindows) {
    const line = [command, ...args].map(quote).join(' ')
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: root,
      encoding: 'utf8',
      stdio,
    })
  }
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio })
}

const run = (command, args, opts) => exec(command, args, opts) ?? ''

function fail(message) {
  console.error(`\n× ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- preflight

console.log(`package : ${name}@${version}`)
console.log(`tag     : ${tag}`)
console.log(`mode    : ${dryRun ? 'dry run' : 'publish'}`)

if (!manifest.dsh?.bundle?.patch) {
  fail('package.json 缺少 dsh.bundle.patch —— 目录收录与市场安装都要求它')
}
if (!fs.existsSync(path.join(root, manifest.dsh.bundle.patch))) {
  fail(`dsh.bundle.patch 指向的文件不存在：${manifest.dsh.bundle.patch}`)
}
for (const required of ['LICENSE', 'README.md', 'CHANGELOG.md', 'screenshots.json']) {
  if (!fs.existsSync(path.join(root, required))) fail(`缺少 ${required}`)
}
if (manifest.repository?.url && !manifest.repository.url.includes('github.com')) {
  fail('repository.url 必须指回被收录的 GitHub 仓库，否则市场不会关联版本')
}

// A published version can never be replaced, so make sure this one is not
// already on the registry before touching anything.
let onRegistry = false
try {
  onRegistry = exec('npm', ['view', `${name}@${version}`, 'version'], { quiet: true }).trim() !== ''
} catch {
  onRegistry = false
}
if (onRegistry) fail(`${name}@${version} 已存在于 registry —— 先提升 package.json 的 version`)
console.log(`registry: ${name}@${version} 尚未发布（继续）`)

// ------------------------------------------------------------------ packing

run('npm', ['pack'])
const tgzPath = path.join(root, tarball)
if (!fs.existsSync(tgzPath)) fail(`打包产物缺失：${tarball}`)
console.log(`\npacked: ${tarball} (${fs.statSync(tgzPath).size} bytes)`)

if (dryRun) {
  console.log('\n--dry-run：跳过 npm publish / git push / gh release。')
  process.exit(0)
}

// ----------------------------------------------------------------- publish

run('npm', ['publish', '--access', 'public'])

run('git', ['add', '-A'])
const staged = exec('git', ['status', '--porcelain'], { quiet: true }).trim()
if (staged) run('git', ['commit', '-m', `release: ${tag}`])
run('git', ['push', 'origin', 'HEAD'])

const releaseNotes = fs.existsSync(path.join(root, 'CHANGELOG.md'))
  ? `发布 ${version}，详见 CHANGELOG.md。`
  : `发布 ${version}。`
run('gh', ['release', 'create', tag, tarball, '--title', tag, '--notes', releaseNotes], {
  alwaysShow: true,
})

console.log(`\n✓ ${name}@${version} 已发布`)
console.log(`  npm      https://www.npmjs.com/package/${name}/v/${version}`)
console.log(`  release  https://github.com/clockclock1/${name}/releases/tag/${tag}`)
console.log('\n目录条目里的 tarball 若钉了旧 tag，同步改 data/plugins/clockclock1__dsh-nitro.yml。')
