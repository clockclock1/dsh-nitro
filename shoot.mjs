// Screenshot helper for the Nitro docs: drives the running DSH web GUI over CDP.
// Usage: node shoot.mjs <name> [--clip=x,y,w,h] [--eval=<js>]
import fs from 'node:fs'
import path from 'node:path'

const CDP = process.env.CDP || 'http://127.0.0.1:9333'
const OUT = process.env.OUT || 'screenshots'

const name = process.argv[2] || 'shot'
const clipArg = process.argv.find((a) => a.startsWith('--clip='))
const evalArg = process.argv.find((a) => a.startsWith('--eval='))

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:43129'))
if (!page) throw new Error('no DSH page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Page.enable')
await send('Runtime.enable')

if (evalArg) {
  const expr = evalArg.slice('--eval='.length)
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  console.log('EVAL:', JSON.stringify(res.result?.value ?? res.result?.description ?? null))
}

let clip
if (clipArg) {
  const [x, y, width, height] = clipArg.slice('--clip='.length).split(',').map(Number)
  clip = { x, y, width, height, scale: 2 }
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
  ...(clip ? { clip } : {}),
})

fs.mkdirSync(OUT, { recursive: true })
const file = path.join(OUT, `${name}.png`)
fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
console.log(`WROTE ${file} (${fs.statSync(file).size} bytes)`)
ws.close()
