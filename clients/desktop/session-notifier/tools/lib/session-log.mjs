// Read a durable session log: the file is a sequence of independently compressed zstd frames (one
// per record), so both single-shot and streaming decompress stop after the first one. Split on the
// frame magic, decompress each frame, and fall back to merging neighbours when a magic byte
// sequence appears inside compressed data.
//
// Run: node tools/probe-session-log-frames.mjs [fileIndex]   — shape of one file
//      node tools/probe-goal-round-gaps.mjs                  — real goal-round gaps
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zstd from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** @returns every offset where a zstd frame magic begins. */
function magicOffsets (buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

/** @returns the records of one session file as parsed JSON objects. */
export function readRecords (file) {
  const buffer = fs.readFileSync(file)
  const offsets = magicOffsets(buffer)
  if (offsets.length === 0) return []

  const records = []
  let index = 0
  while (index < offsets.length) {
    let merged = null
    // A magic inside compressed payload splits one frame into two candidates; merging until the
    // frame decompresses is what makes the splitter safe rather than clever.
    for (let end = index + 1; end <= offsets.length; end++) {
      const start = offsets[index]
      const stop = end < offsets.length ? offsets[end] : buffer.length
      try {
        const text = zstd.zstdDecompressSync(buffer.subarray(start, stop)).toString('utf8')
        merged = { text, next: end }
        break
      } catch {
        /* try a longer slice */
      }
    }
    if (merged === null) break
    for (const line of merged.text.split('\n')) {
      if (line.trim() === '') continue
      try { records.push(JSON.parse(line)) } catch { /* skip malformed */ }
    }
    index = merged.next
  }
  return records
}

/** @returns every session file under the DSH session store. */
export function sessionFiles () {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) files.push(full)
    }
  }
  walk(root)
  return files
}
