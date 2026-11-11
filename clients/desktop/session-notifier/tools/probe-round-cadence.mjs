// Distribution of turn/end -> next turn/start across every session, split by *what* resumed the
// turn. A resumed turn's prompt is persisted after `turn/start`, so the classifier has to read
// inside the new turn; at the boundary itself a goal round, a settled Subagent and a queued
// follow-up look identical.
//
// The split is the point. A goal round continues in milliseconds, while a Subagent settlement can
// wake the parent minutes later — those are different events and must not be averaged into one
// "automatic continuation" figure, or the number stops meaning anything.
//
// Run: node clients/desktop/session-notifier/tools/probe-round-cadence.mjs   (from the repo root)
import { readRecords, sessionFiles } from './lib/session-log.mjs'

/** Message sources the Session produces for itself, without a human at the keyboard. */
const AUTO = new Set(['goal', 'subagent-settled', 'rule'])

const samples = []
for (const file of sessionFiles()) {
  let records
  try { records = readRecords(file) } catch { continue }
  const marks = []
  for (const record of records) {
    if (typeof record.time !== 'number') continue
    if (record.type === 'turn/end') marks.push({ kind: 'end', time: record.time })
    else if (record.type === 'turn/start') marks.push({ kind: 'start', time: record.time })
    else if (record.type === 'user/message') marks.push({ kind: 'user', time: record.time, source: record.data?.source?.kind })
  }
  marks.sort((a, b) => a.time - b.time)

  for (let i = 0; i < marks.length; i++) {
    if (marks[i].kind !== 'end') continue
    const startIndex = marks.findIndex((mark, index) => index > i && mark.kind === 'start')
    if (startIndex === -1) continue
    // Classify the resumed turn by the prompts it carries before it ends again.
    let source
    let human = false
    for (let j = startIndex + 1; j < marks.length && marks[j].kind !== 'end'; j++) {
      if (marks[j].kind !== 'user') continue
      if (AUTO.has(marks[j].source)) source ??= marks[j].source
      else human = true
    }
    samples.push({ ms: marks[startIndex].time - marks[i].time, source: human || source === undefined ? 'human' : source })
  }
}

const groups = new Map()
for (const sample of samples) {
  const list = groups.get(sample.source) ?? []
  list.push(sample.ms)
  groups.set(sample.source, list)
}

const describe = (label, values) => {
  if (values.length === 0) { console.log(`${label}: none`); return }
  const sorted = values.slice().sort((a, b) => a - b)
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  console.log(`${label.padEnd(17)} n=${String(sorted.length).padStart(5)}  min=${String(sorted[0]).padStart(7)}ms  p50=${String(pick(0.5)).padStart(7)}ms  p90=${String(pick(0.9)).padStart(7)}ms  p99=${String(pick(0.99)).padStart(8)}ms  max=${String(sorted.at(-1)).padStart(9)}ms`)
}

const ORDER = ['goal', 'subagent-settled', 'rule', 'human']
console.log('=== resumed by ===')
for (const key of ORDER) if (groups.has(key)) describe(key, groups.get(key))
for (const [key, values] of groups) if (!ORDER.includes(key)) describe(key, values)

const bucket = (ms) => (ms < 50 ? '<50ms' : ms < 200 ? '50-200ms' : ms < 1000 ? '0.2-1s' : ms < 5000 ? '1-5s' : ms < 60000 ? '5-60s' : '>60s')
const BUCKETS = ['<50ms', '50-200ms', '0.2-1s', '1-5s', '5-60s', '>60s']
for (const [label, values] of groups) {
  const histogram = new Map()
  for (const ms of values) histogram.set(bucket(ms), (histogram.get(bucket(ms)) ?? 0) + 1)
  console.log(`\n${label} buckets:`)
  for (const key of BUCKETS) if (histogram.has(key)) console.log(`  ${key.padStart(8)}: ${histogram.get(key)}`)
}

// What a deferral window would absorb, per source. Read this as "how much of this source is really
// a continuation, not a Session that genuinely went idle".
console.log('\n=== share absorbed by a window ===')
for (const [label, values] of groups) {
  if (label === 'human') continue
  const rows = [1200, 15000].map((limit) => {
    const within = values.filter((ms) => ms <= limit).length
    return `${limit}ms ${Math.round((within / values.length) * 1000) / 10}%`
  })
  console.log(`  ${label.padEnd(17)} ${rows.join('  ')}`)
}
