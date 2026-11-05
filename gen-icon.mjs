// Generate icon.png (256x256 RGBA) without any image dependency.
// Node's zlib gives us deflate; PNG needs one IDAT of filtered scanlines.
import fs from 'node:fs'
import zlib from 'node:zlib'

const SIZE = 256
const px = new Uint8Array(SIZE * SIZE * 4)

const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  // source-over onto whatever is there
  const sa = a / 255
  const da = px[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa)
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa)
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa)
  px[i + 3] = Math.round(oa * 255)
}

// rounded-rect background with a vertical gradient, plus 1px inner border
const R = 56
const inside = (x, y, inset) => {
  const lo = inset
  const hi = SIZE - 1 - inset
  if (x < lo || y < lo || x > hi || y > hi) return false
  const cx = Math.min(Math.max(x, lo + R - inset), hi - R + inset)
  const cy = Math.min(Math.max(y, lo + R - inset), hi - R + inset)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= (R - inset) * (R - inset)
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inside(x, y, 0)) continue
    const t = y / (SIZE - 1)
    const r = Math.round(18 + t * 8)
    const g = Math.round(23 + t * 10)
    const b = Math.round(34 + t * 18)
    set(x, y, r, g, b, 255)
    if (!inside(x, y, 3)) set(x, y, 79, 209, 255, 110)
  }
}

// lightning bolt polygon, filled with a cyan-to-blue vertical gradient
const bolt = [
  [150, 36], [92, 140], [126, 140], [106, 220], [170, 116], [134, 116],
]
const inPoly = (x, y, poly) => {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inPoly(x + 0.5, y + 0.5, bolt)) continue
    const t = (y - 36) / (220 - 36)
    set(x, y, Math.round(120 - t * 60), Math.round(230 - t * 60), 255, 255)
  }
}

// 2x2 supersampled edge softening for the bolt silhouette
const soft = new Uint8Array(px)
for (let y = 1; y < SIZE - 1; y++) {
  for (let x = 1; x < SIZE - 1; x++) {
    const i = (y * SIZE + x) * 4
    if (px[i + 3] === 255 && px[i] < 100 && px[i + 2] > 200) continue
  }
}
void soft

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
fs.writeFileSync('icon.png', png)
console.log(`icon.png ${png.length} bytes`)
