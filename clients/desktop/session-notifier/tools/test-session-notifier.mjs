// Behavioural test for the Session notifier client half.
// Loads the real client.js with fake browser globals (Notification, AudioContext, localStorage,
// document) and a fake `uiSession.sessionStatus` projection, then drives status transitions and
// asserts the alerts the user would receive.
//
// Time is a controlled clock: a completion alert is deliberately deferred until the Session proves
// it stopped working, so every completion assertion advances the clock instead of reading the
// result immediately. Interaction alerts are immediate and need no advancing.
//
// This is not browser verification: it proves the alert decision table and the wiring, not the
// live page.
// Run: node clients/desktop/session-notifier/tools/test-session-notifier.mjs   (from the repo root)
import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Settle window plus a margin, mirroring COMPLETION_SETTLE_MS in client.js. */
const SETTLE_MS = 1300
/** Goal quiet window plus a margin, mirroring GOAL_QUIET_MS in client.js. */
const GOAL_QUIET_MS = 15100

const notifications = []
let audioContexts = []

class FakeNotification {
  static permission = 'granted'
  static requestPermission = async () => 'granted'
  constructor (title, options) {
    this.title = title
    this.options = options
    this.closed = false
    notifications.push(this)
  }
  close () { this.closed = true }
}

class FakeAudioContext {
  constructor () {
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
    this.tones = []
    audioContexts.push(this)
  }
  resume () { this.state = 'running'; return Promise.resolve() }
  createOscillator () {
    const tones = this.tones
    return {
      type: '',
      frequency: { setValueAtTime: (value) => tones.push(value) },
      connect: (target) => target,
      start: () => {},
      stop: () => {},
    }
  }
  createGain () {
    return {
      gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (target) => target,
    }
  }
}

const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

function createStorage (initial) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    dump: () => Object.fromEntries(map),
  }
}

/** Deterministic clock: the deferral is only testable when time is controllable. */
function createClock () {
  let now = 1_700_000_000_000
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    set (fn, delay) {
      seq += 1
      timers.set(seq, { at: now + (Number.isFinite(delay) ? delay : 0), fn })
      return seq
    },
    clear (id) { timers.delete(id) },
    /** Run every timer due inside the window, in order, then leave the clock at the end. */
    advance (ms) {
      const target = now + ms
      for (;;) {
        let dueId
        let dueAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) { dueId = id; dueAt = timer.at }
        }
        if (dueId === undefined) break
        const timer = timers.get(dueId)
        timers.delete(dueId)
        now = timer.at
        timer.fn()
      }
      now = target
    },
  }
}

const SESSIONS = {
  s1: { id: 's1', displayTitle: 'My session' },
  s2: { id: 's2', displayTitle: 'Second session' },
  s3: { id: 's3', displayTitle: 'Third session' },
  s4: { id: 's4', displayTitle: 'Fourth session' },
  s5: { id: 's5', displayTitle: 'Fifth session' },
  s6: { id: 's6', displayTitle: 'Sixth session' },
  sub1: { id: 'sub1', displayTitle: 'researcher', origin: 'subagent' },
}

/** A catalog row carrying a durable goal projection of the given phase and round counter. */
const withGoal = (row, phase, rounds) => ({
  ...row,
  projectionValues: { goal: { goal: { id: 'g1', revision: 1, objective: 'Ship it', phase }, roundsStarted: rounds } },
})

/** Boot one isolated plugin instance. */
function boot ({ storage = {}, focused = true, current = undefined, permission = 'granted', initialStatus = undefined } = {}) {
  notifications.length = 0
  audioContexts = []
  FakeNotification.permission = permission

  const clock = createClock()
  globalThis.setTimeout = (fn, delay) => clock.set(fn, delay)
  globalThis.clearTimeout = (id) => clock.clear(id)
  Date.now = () => clock.now()

  let focusedNow = focused

  let definition
  const events = []
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    localStorage: createStorage(storage),
    AudioContext: FakeAudioContext,
    addEventListener: (type) => { events.push(type) },
    removeEventListener: () => {},
    focus: () => {},
    setTimeout: (fn, delay) => clock.set(fn, delay),
  }
  globalThis.document = { visibilityState: 'visible', hasFocus: () => focusedNow }
  globalThis.Notification = FakeNotification

  new Function(source)()
  const plugin = definition.factory(() => fakeReact)

  let status = initialStatus ?? new Map()
  const listeners = new Set()
  const statusStore = {
    getSnapshot: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      status = next
      for (const listener of [...listeners]) listener()
    },
  }

  let sessionRows = SESSIONS
  const catalogListeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: sessionRows }),
      subscribe: (listener) => {
        catalogListeners.add(listener)
        return () => { catalogListeners.delete(listener) }
      },
    },
  }

  const uiSession = {
    sessionStatus: statusStore,
    adapter: { current: { getSnapshot: () => (current === undefined ? undefined : { key: current }) } },
  }

  const cleanups = []
  const registrations = []
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (owner, callback) => { callback() },
      register: (options) => {
        registrations.push({
          id: options.id,
          name: options.name,
          props: typeof options.inject === 'function' ? options.inject() : undefined,
        })
        return () => {}
      },
    },
    effect: (fn, label) => { events.push(`effect:${label}`); const off = fn(); cleanups.push(off) },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['uiSession', 'sessions'])
      const scope = {
        uiSession,
        sessions,
        effect: (fn) => { const off = fn(); cleanups.push(off) },
      }
      callback(scope)
    },
  }

  plugin.apply(ctx)
  return {
    statusStore,
    registrations,
    clock,
    /** Replace the catalog rows and notify subscribers, as a projection change would. */
    setSessionRows: (rows, { touch = true } = {}) => {
      sessionRows = rows
      if (!touch) return
      for (const listener of [...catalogListeners]) listener()
    },
    /** Move the window between focused and unfocused without reloading anything. */
    setFocused: (value) => { focusedNow = value },
    dispose: () => { for (const off of cleanups.reverse()) if (typeof off === 'function') off() },
  }
}

const running = (id, extra = {}) => [id, { running: true, pendingInteraction: undefined, completionUnread: false, ...extra }]
const idle = (id, extra = {}) => [id, { running: false, pendingInteraction: undefined, completionUnread: false, ...extra }]

const tones = () => audioContexts.reduce((sum, context) => sum + context.tones.length, 0)
const titles = () => notifications.map((item) => item.title)
const bodies = () => notifications.map((item) => item.options.body)

let failures = 0
function check (name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('Session notifier decision table')

// ---------------------------------------------------------------- completion delivery

check('turn end while away raises a sound and a desktop notification once the Session settles', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  assert.equal(notifications.length, 0, 'a turn boundary alone is not an alert yet')
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
  assert.deepEqual(bodies(), ['My session'])
  assert.match(notifications[0].options.tag, /^dsh[0-9a-z]+-[0-9a-z]+$/u, 'the tag is unique per alert')
  assert.ok(notifications[0].options.tag.length <= 16, 'the tag fits the Windows 16-character cap')
  assert.ok(notifications[0].options.icon.startsWith('data:image/png;base64,'), 'the DSH icon is embedded')
  assert.ok(notifications[0].options.icon.length > 1000, 'the embedded icon is a real image')
  assert.equal(notifications[0].options.requireInteraction, true, 'the banner stays on screen')
  assert.equal(notifications[0].options.renotify, true, 'a replacement re-alerts instead of swapping silently')
  assert.equal(notifications[0].options.silent, true, 'the plugin plays its own chime')
  assert.ok(tones() >= 2, 'expected a two-tone chime')
})

check('the alert waits out the settle window instead of firing on the boundary', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(900)
  assert.equal(notifications.length, 0, 'nothing may be delivered before the window elapses')
  clock.advance(500)
  assert.equal(notifications.length, 1)
})

check('only the Settings row is registered; no in-app overlay is contributed', () => {
  const { registrations } = boot()
  assert.deepEqual(registrations.map((item) => item.name), ['settings.general.item'])
})

// ---------------------------------------------------------------- loop suppression

check('a goal round that resumes the turn raises nothing', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  // The goal round driver admits the next round ~12 ms after the turn ends, so the client sees the
  // same true -> false -> true edge a real completion produces.
  statusStore.set(new Map([idle('s1')]))
  clock.advance(12)
  statusStore.set(new Map([running('s1')]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0, 'a resumed Session was never waiting for the user')
  assert.equal(tones(), 0)
})

check('a whole round trip of a goal loop only alerts when it finally stops', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  for (let round = 0; round < 8; round++) {
    statusStore.set(new Map([idle('s1')]))
    clock.advance(20)
    statusStore.set(new Map([running('s1')]))
    clock.advance(3000)
  }
  assert.equal(notifications.length, 0, 'no notification for any of the eight rounds')
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'], 'the round that really ends the work is reported')
})

check('an active goal whose rounds keep advancing stays silent past the settle window', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  // The driver is slow this time: a durability checkpoint holds the next round back for 11 s.
  clock.advance(11000)
  assert.equal(notifications.length, 0, 'an active goal is still working, so nothing is due yet')
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 6) })
  statusStore.set(new Map([running('s1')]))
  clock.advance(GOAL_QUIET_MS * 2)
  assert.equal(notifications.length, 0, 'the goal admitted its round, so that boundary was not the end')
})

check('an active goal that stops advancing is reported once its quiet window elapses', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(GOAL_QUIET_MS - 500)
  assert.equal(notifications.length, 0, 'still inside the goal quiet window')
  clock.advance(1000)
  assert.deepEqual(titles(), ['alert.completion'], 'a stalled goal must not silence its Session forever')
})

check('a goal round the client never saw running still counts as a continuation', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  // The next round is admitted and finishes again between two client snapshots: the running edge
  // never reaches the page, and the only evidence left is the goal moving on a round.
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 6) })
  clock.advance(GOAL_QUIET_MS * 2)
  assert.equal(notifications.length, 0, 'the held boundary belongs to a round that already passed')
})

check('a goal that completes is reported on the normal settle window', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  // Completion flips the projection to `complete`: the loop is over, so the long window no longer applies.
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'complete', 5) })
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a paused goal is reported on the normal settle window', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'paused', 5) })
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a blocked goal is reported on the normal settle window', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'active', 5) })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  setSessionRows({ ...SESSIONS, s1: withGoal(SESSIONS.s1, 'blocked', 5) })
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a queued follow-up that resumes the turn raises nothing', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(40)
  statusStore.set(new Map([running('s1')]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0)
})

check('a Session that never resumes is reported once, not once per re-check', () => {
  const { statusStore, clock, setSessionRows } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  for (let i = 0; i < 3; i++) {
    setSessionRows(SESSIONS)
    statusStore.set(new Map([idle('s1')]))
    clock.advance(500)
  }
  assert.equal(notifications.length, 1, 'the completed alert must not repeat')
})

// ---------------------------------------------------------------- interactions stay immediate

check('a question alert is delivered immediately, without waiting for any window', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([running('s1', { pendingInteraction: { kind: 'question', key: 'q1', questions: [{ question: '  Which   one?  ' }] } })]))
  assert.deepEqual(titles(), ['alert.question'], 'a Session asking something is waiting by definition')
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1, 'and it is not replayed later')
  assert.deepEqual(bodies(), ['My session · Which one?'])
  assert.equal(notifications[0].options.requireInteraction, true, 'an interaction request stays on screen')
})

check('an approval alert carries the tool and the reason, immediately', () => {
  const { statusStore } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([running('s1', { pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash', displayReason: 'Run the migration' } })]))
  assert.deepEqual(titles(), ['alert.approval'])
  assert.deepEqual(bodies(), ['My session · bash · Run the migration'])
})

check('a plan review alert uses its own heading', () => {
  const { statusStore } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([running('s1', { pendingInteraction: { kind: 'plan-review', key: 'p1', questions: [{ header: 'Plan outline' }] } })]))
  assert.deepEqual(titles(), ['alert.planReview'])
  assert.deepEqual(bodies(), ['My session · Plan outline'])
})

check('a pending interaction replaces the completion alert for that Session', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1', { pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash' } })]))
  assert.deepEqual(titles(), ['alert.approval'])
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 1, 'the deferred completion is dropped, not delivered twice')
})

check('the same interaction is not alerted twice', () => {
  const { statusStore } = boot()
  const interaction = { kind: 'question', key: 'q1', questions: [{ question: 'Once?' }] }
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([running('s1', { pendingInteraction: interaction })]))
  assert.equal(notifications.length, 1)
  statusStore.set(new Map([running('s1', { pendingInteraction: interaction })]))
  assert.equal(notifications.length, 1)
})

// ---------------------------------------------------------------- focus / preferences

check('the same Session is not alerted while focused on screen', () => {
  const { statusStore, clock } = boot({ focused: true, current: 's1' })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.equal(tones(), 0)
})

check('the focus check happens at delivery time, not when the turn ended', () => {
  const { statusStore, clock, setFocused } = boot({ focused: false, current: 's1' })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  // The user comes back to the window while the plugin is still deciding.
  setFocused(true)
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0, 'nobody needs a banner for the Session they are already watching')
})

check('another Session still alerts while one is on screen', () => {
  const { statusStore, clock } = boot({ focused: true, current: 's1' })
  statusStore.set(new Map([running('s1'), running('s2')]))
  statusStore.set(new Map([running('s1'), idle('s2')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
  assert.deepEqual(bodies(), ['Second session'])
})

check('an unfocused window alerts for the Session on screen', () => {
  const { statusStore, clock } = boot({ focused: false, current: 's1' })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a stored preference of skipFocused=false alerts even while watching', () => {
  const { statusStore, clock } = boot({
    focused: true,
    current: 's1',
    storage: { 'dsh.session-notifier.v1': JSON.stringify({ sound: true, desktop: true, skipFocused: false }) },
  })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('desktop=false keeps the sound and drops the notification', () => {
  const { statusStore, clock } = boot({
    storage: { 'dsh.session-notifier.v1': JSON.stringify({ sound: true, desktop: false, skipFocused: true }) },
  })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.ok(tones() >= 2)
})

check('sound=false keeps the notification and drops the chime', () => {
  const { statusStore, clock } = boot({
    storage: { 'dsh.session-notifier.v1': JSON.stringify({ sound: false, desktop: true, skipFocused: true }) },
  })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
  assert.equal(tones(), 0)
})

check('malformed stored preferences fall back to the defaults', () => {
  const { statusStore, clock } = boot({ storage: { 'dsh.session-notifier.v1': '{not json' } })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a denied permission suppresses desktop notifications but not the sound', () => {
  const { statusStore, clock } = boot({ permission: 'denied' })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.ok(tones() >= 2)
})

// ---------------------------------------------------------------- unread / batching / subagents

check('an unread completion is alerted even without an observed running edge', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1', { completionUnread: true })]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('state already unread at install time is not alerted, and the next one is', () => {
  const { statusStore, clock } = boot({ initialStatus: new Map([idle('s1', { completionUnread: true })]) })
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.equal(tones(), 0)
  statusStore.set(new Map([idle('s1', { completionUnread: true }), running('s2')]))
  statusStore.set(new Map([idle('s1', { completionUnread: true }), idle('s2')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
  assert.deepEqual(bodies(), ['Second session'])
})

check('a burst of completions is capped', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map(['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => running(id))))
  statusStore.set(new Map(['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => idle(id))))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 4)
  assert.ok(tones() >= 2, 'the burst still plays one chime')
})

check('a second alert in the same Session retires the old toast and uses a fresh tag', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 2)
  assert.notEqual(notifications[0].options.tag, notifications[1].options.tag, 'Windows must not treat it as a replacement')
  assert.equal(notifications[0].closed, true, 'the previous toast is closed')
  assert.equal(notifications[1].closed, false)
})

check('a Subagent finishing its own Session raises nothing', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('sub1')]))
  statusStore.set(new Map([idle('sub1')]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0, 'no desktop notification for a Subagent completion')
  assert.equal(tones(), 0, 'no chime either')
})

check('a Subagent finishing stays silent even when it is the only thing that happened', () => {
  const { statusStore, clock } = boot({ focused: false })
  statusStore.set(new Map([running('s1'), running('sub1')]))
  statusStore.set(new Map([running('s1'), idle('sub1')]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0, 'the main Session is still running, so nothing is reported')
})

check('a Subagent unread completion is dropped as well', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([idle('sub1', { completionUnread: true })]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0)
  assert.equal(tones(), 0)
})

check('a Subagent that stops to ask a question still alerts', () => {
  const { statusStore } = boot()
  statusStore.set(new Map([running('sub1')]))
  statusStore.set(new Map([running('sub1', { pendingInteraction: { kind: 'question', key: 'q1', questions: [{ question: 'Which file?' }] } })]))
  assert.deepEqual(titles(), ['alert.question'])
  assert.deepEqual(bodies(), ['alert.subagent researcher · Which file?'])
  assert.ok(tones() >= 2, 'a Subagent waiting on the user still chimes')
})

check('a Subagent that stops for an approval still alerts', () => {
  const { statusStore } = boot()
  statusStore.set(new Map([running('sub1')]))
  statusStore.set(new Map([running('sub1', { pendingInteraction: { kind: 'approval', key: 'a1', toolName: 'bash' } })]))
  assert.deepEqual(titles(), ['alert.approval'])
  assert.deepEqual(bodies(), ['alert.subagent researcher · bash'])
})

check('a Subagent completion does not drown out another Session in the same batch', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1'), running('sub1')]))
  statusStore.set(new Map([idle('s1'), idle('sub1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'], 'only the main Session is reported')
  assert.deepEqual(bodies(), ['My session'])
})

check('the final answer of the main Session still alerts when its Subagent is also known', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('sub1'), running('s1')]))
  statusStore.set(new Map([idle('sub1'), idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(bodies(), ['My session'])
})

// ---------------------------------------------------------------- catalog edge cases

check('only an origin of subagent is muted, not a Session merely named like one', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({
    ...SESSIONS,
    s1: { id: 's1', displayTitle: 'forked from a Subagent' },
    sub1: { id: 'sub1', displayTitle: 'researcher', origin: 'subagent', parentId: 's1' },
  })
  statusStore.set(new Map([running('s1'), running('sub1')]))
  statusStore.set(new Map([idle('s1'), idle('sub1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(bodies(), ['forked from a Subagent'])
})

check('a catalog row without origin is treated as an ordinary Session', () => {
  const { statusStore, clock } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('a catalog row with no goal projection still alerts on the settle window', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows({ s1: { id: 's1', displayTitle: 'My session', projectionValues: { title: 'My session' } } })
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'])
})

check('an unreadable catalog does not mute a real completion', () => {
  const { statusStore, clock, setSessionRows } = boot()
  setSessionRows(new Proxy({}, { get: () => { throw new Error('projection unavailable') } }))
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  clock.advance(SETTLE_MS)
  assert.deepEqual(titles(), ['alert.completion'], 'a failed lookup falls back to an ordinary Session')
  assert.deepEqual(bodies(), ['s1'], 'the body degrades to the raw id')
})

// ---------------------------------------------------------------- lifecycle

check('disposing the plugin cancels a pending completion', () => {
  const { statusStore, clock, dispose } = boot()
  statusStore.set(new Map([running('s1')]))
  statusStore.set(new Map([idle('s1')]))
  dispose()
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 0)
})

check('a catalog without a subscribe accessor still works', () => {
  notifications.length = 0
  let definition
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    localStorage: createStorage({}),
    AudioContext: FakeAudioContext,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = { visibilityState: 'visible', hasFocus: () => false }
  new Function(source)()
  const plugin = definition.factory(() => fakeReact)
  let status = new Map()
  const listeners = new Set()
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (owner, callback) => { callback() }, register: () => () => {} },
    effect: (fn) => { fn() },
    inject: (deps, callback) => {
      callback({
        uiSession: {
          sessionStatus: {
            getSnapshot: () => status,
            subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
          },
          adapter: { current: { getSnapshot: () => undefined } },
        },
        // No `subscribe` on the list store: the catalog-driven re-check is optional.
        sessions: { list: { getSnapshot: () => ({ byId: SESSIONS }) } },
        effect: (fn) => fn(),
      })
    },
  }
  plugin.apply(ctx)
  status = new Map([running('s1')])
  for (const listener of [...listeners]) listener()
  status = new Map([idle('s1')])
  for (const listener of [...listeners]) listener()
  assert.equal(notifications.length, 0, 'the candidate is held without crashing')
})

check('the plugin registers its Settings row and both halves of the wiring', () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    localStorage: createStorage({}),
    AudioContext: FakeAudioContext,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  new Function(source)()
  assert.equal(definition.id, '@local/dsh-session-notifier')
  const registered = []
  const plugin = definition.factory(() => fakeReact)
  const ctx = {
    locale: { register: (ns, dicts) => { registered.push(`locale:${ns}:${Object.keys(dicts).join('+')}`); return () => {} }, bind: () => (key) => key },
    slots: { inject: (owner, callback) => { registered.push(`slot:${owner}`); callback() }, register: (options) => { registered.push(`row:${options.id}`); return () => {} } },
    effect: (fn) => { fn() },
    inject: (deps, callback) => {
      registered.push(`inject:${deps.join('+')}`)
      callback({
        uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
        sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
        effect: (fn) => fn(),
      })
    },
  }
  plugin.apply(ctx)
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.deepEqual(registered, [
    'locale:session-notifier:zh+en',
    'slot:settings.general.item',
    'row:session-notifier',
    'inject:uiSession+sessions',
  ])
})

if (failures === 0) {
  console.log('\nAll notifier checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
