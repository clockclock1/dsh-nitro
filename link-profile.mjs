// dsh-nitro — 把插件装进 web profile，做法与桌面安装器一致：
// 一个 generation 目录 + junction + profile.json 三处条目。
//
//   node link-profile.mjs          -> apply
//   node link-profile.mjs --revert -> undo
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROFILE = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web'
const PKG = 'dsh-nitro'
const VERSION = '1.0.0'
const GEN = `${PKG}+${VERSION}+${hash12(`${PKG}+${VERSION}`)}`
const revert = process.argv.includes('--revert')

const manifestPath = path.join(PROFILE, 'package.json')
const junction = path.join(PROFILE, 'node_modules', PKG)
const genRoot = path.join(PROFILE, '..', '.generations', 'live', GEN)
const genTarget = path.join(genRoot, 'node_modules', PKG)
const source = path.dirname(fileURLToPath(import.meta.url))

function hash12(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------- generation

// Re-running copies the shipped files every time, so a lib edit reaches the
// profile without deleting the generation by hand.
const SHIPPED = ['lib', 'cordis.patch.yml', 'package.json', 'README.md']

function materialize() {
  if (!fs.existsSync(genTarget)) {
    fs.mkdirSync(path.dirname(genTarget), { recursive: true })
    fs.cpSync(source, genTarget, { recursive: true })
  } else {
    for (const entry of SHIPPED) {
      const from = path.join(source, entry)
      if (fs.existsSync(from)) fs.cpSync(from, path.join(genTarget, entry), { recursive: true })
    }
  }
  const meta = path.join(genRoot, 'generation.json')
  const body = JSON.stringify({ pluginName: PKG, version: VERSION }, null, 2) + '\n'
  fs.writeFileSync(meta, body, 'utf8')
  console.log(`generation ready: ${genRoot}`)
  console.log(`source dir: ${source}`)
}

// ---------------------------------------------------------------- junction

function junctionState(target) {
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isSymbolicLink()) return 'file'
    return fs.realpathSync(target).replace(/\\/g, '/').toLowerCase()
  } catch {
    return 'absent'
  }
}

function link() {
  const before = junctionState(junction)
  console.log(`junction before: ${before}`)
  if (revert) {
    if (before !== 'absent' && before !== 'file') {
      fs.unlinkSync(junction)
      console.log('junction removed')
    }
    return
  }
  if (before === 'absent') {
    fs.mkdirSync(path.dirname(junction), { recursive: true })
    execFileSync('cmd', ['/c', 'mklink', '/J', junction, genTarget], { stdio: 'inherit' })
    console.log(`junction created -> ${genTarget}`)
  } else {
    console.log('junction already present')
  }
}

// --------------------------------------------------------------- manifest

function manifest() {
  const file = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (revert) {
    delete file.dependencies[PKG]
    file.dsh.profile.bundles = file.dsh.profile.bundles.filter((b) => b !== PKG)
    delete file.dsh.desktop.generationProjection.plugins[PKG]
    delete file.pnpm.overrides[PKG]
  } else {
    file.dependencies[PKG] = VERSION
    if (!file.dsh.profile.bundles.includes(PKG)) file.dsh.profile.bundles.push(PKG)
    file.dsh.desktop.generationProjection.plugins[PKG] = {
      generationId: GEN,
      visibleVersion: VERSION,
      previousOverride: { present: false },
    }
    file.pnpm.overrides[PKG] = `link:../.generations/live/${GEN}/node_modules/${PKG}`
  }
  const backup = path.join(PROFILE, 'package.json.nitro.bak')
  if (!revert && !fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup)
  fs.writeFileSync(manifestPath, JSON.stringify(file, null, 2) + '\n', 'utf8')
  console.log(`${revert ? 'reverted' : 'written'}: ${manifestPath}`)
  console.log('bundles:', file.dsh.profile.bundles.join(', '))
}

if (!revert) materialize()
link()
manifest()
