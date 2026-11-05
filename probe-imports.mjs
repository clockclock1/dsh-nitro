import fs from 'node:fs'
import path from 'node:path'

const root = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules'
const names = [
  'dsh-progress-widget',
  'dsh-purge',
  'dsh-theme-endfield',
  'dsh-free-search',
  'dsh-client-auto-continue',
  'billion-context',
  'dsh-better-sidebar',
  'dsh-plugin-tlnotify',
]

for (const name of names) {
  const candidates = [
    path.join(root, name, 'lib', 'index.js'),
    path.join(root, name, 'index.js'),
    path.join(root, name, 'dist', 'index.js'),
  ]
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) {
    console.log(`${name}: (no entry found)`)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  const matches = [...text.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const bare = [...new Set(matches)].filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'))
  console.log(`${name} -> ${JSON.stringify(bare)}`)
}
