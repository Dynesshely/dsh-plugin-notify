// Distribution of turn/end -> next turn/start across every session, classifying the resumed turn by
// the messages it actually carries. The goal driver queues its round prompt inside the new turn
// (`agent/inbox/spliced` -> `turn/start` -> `user/message` with source.kind "goal"), so the
// discriminator has to look forward into the turn, not backward at the boundary.
//
// Run: node clients/desktop/session-notifier/tools/probe-round-cadence.mjs   (from the repo root)
import { readRecords, sessionFiles } from './lib/session-log.mjs'

const AUTO = new Set(['goal', 'subagent-settled', 'rule'])

const samples = []   // { ms, auto }
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
    // Classify the resumed turn by the user messages it carries before it ends again.
    let auto = false
    let human = false
    for (let j = startIndex + 1; j < marks.length && marks[j].kind !== 'end'; j++) {
      if (marks[j].kind !== 'user') continue
      if (AUTO.has(marks[j].source)) auto = true
      else human = true
    }
    samples.push({ ms: marks[startIndex].time - marks[i].time, auto: auto && !human })
  }
}

const describe = (label, values) => {
  if (values.length === 0) { console.log(`${label}: none`); return }
  const sorted = values.slice().sort((a, b) => a - b)
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  console.log(`${label}: n=${sorted.length} min=${sorted[0]}ms p50=${pick(0.5)}ms p90=${pick(0.9)}ms p99=${pick(0.99)}ms max=${sorted.at(-1)}ms`)
}

const auto = samples.filter((sample) => sample.auto).map((sample) => sample.ms)
const rest = samples.filter((sample) => !sample.auto).map((sample) => sample.ms)
describe('resumed turn carried an automatic prompt', auto)
describe('resumed turn carried human input', rest)

const bucket = (ms) => (ms < 50 ? '<50ms' : ms < 200 ? '50-200ms' : ms < 500 ? '0.2-0.5s' : ms < 1000 ? '0.5-1s' : ms < 5000 ? '1-5s' : ms < 60000 ? '5-60s' : '>60s')
const ORDER = ['<50ms', '50-200ms', '0.2-0.5s', '0.5-1s', '1-5s', '5-60s', '>60s']
for (const [label, values] of [['automatic', auto], ['human', rest]]) {
  const histogram = new Map()
  for (const ms of values) histogram.set(bucket(ms), (histogram.get(bucket(ms)) ?? 0) + 1)
  console.log(`\n${label} buckets:`)
  for (const key of ORDER) if (histogram.has(key)) console.log(`  ${key.padStart(8)}: ${histogram.get(key)}`)
}

const share = (limit) => {
  if (auto.length === 0) return 0
  return Math.round((auto.filter((ms) => ms <= limit).length / auto.length) * 1000) / 10
}
console.log('\nshare of automatic continuations absorbed by a settle window:')
for (const limit of [200, 500, 1000, 1500, 2000, 3000, 5000]) console.log(`  ${String(limit).padStart(5)}ms -> ${share(limit)}%`)

const slowAuto = auto.filter((ms) => ms >= 1000).sort((a, b) => b - a).slice(0, 10)
if (slowAuto.length > 0) {
  console.log('\nslowest automatic continuations (>=1s):')
  for (const ms of slowAuto) console.log(`  ${ms}ms`)
}
