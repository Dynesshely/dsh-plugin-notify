// Behavioural test for the unified Session notifier client half.
//
// Loads the real client.js with fake browser globals (Notification, AudioContext,
// localStorage, document, Image/canvas) and a fake `uiSession.sessionStatus`
// projection, then drives status transitions and asserts the alerts the user
// would receive. Time is a controlled clock: completion alerts are deferred until
// the Session proves it stopped working, so every completion assertion advances
// the clock instead of reading the result immediately.
//
// This is not browser verification: it proves the alert decision table and the
// wiring, not the live page (audio output and the OS toast remain GUI-only).
// Run: node session-notifier/tools/test-session-notifier.mjs
import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const realSetTimeout = setTimeout

/** Settle window plus a margin, mirroring COMPLETION_SETTLE_MS in client.js. */
const SETTLE_MS = 1300
/** Goal quiet window plus a margin, mirroring GOAL_QUIET_MS in client.js. */
const GOAL_QUIET_MS = 15100

const notifications = []
let audioContexts = []
let permissionRequests = 0

class FakeNotification {
  static permission = 'granted'
  static requestPermission = async () => {
    permissionRequests += 1
    return FakeNotification.permission
  }

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
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: (target) => target,
    }
  }
}

const fakeReact = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity)
    const nextProps = props ?? {}
    // Render function components eagerly: the harness has no reconciler, and
    // this is enough for the settings page tree assertions.
    if (typeof type === 'function') return type({ ...nextProps, children: flat.length === 1 ? flat[0] : flat })
    return { type, props: nextProps, children: flat }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    const off = fn()
    return off
  },
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
  child1: { id: 'child1', displayTitle: 'child', parentId: 's1' },
}

/** A catalog row carrying a durable goal projection of the given phase and round counter. */
const withGoal = (row, phase, rounds) => ({
  ...row,
  projectionValues: { goal: { goal: { id: 'g1', revision: 1, objective: 'Ship it', phase }, roundsStarted: rounds } },
})

/** Boot one isolated plugin instance. */
async function boot ({ storage = {}, focused = true, current = undefined, permission = 'granted', initialStatus = undefined, notificationApi = true, withWorkspace = true } = {}) {
  notifications.length = 0
  audioContexts = []
  permissionRequests = 0
  FakeNotification.permission = permission

  const clock = createClock()
  globalThis.setTimeout = (fn, delay) => clock.set(fn, delay)
  globalThis.clearTimeout = (id) => clock.clear(id)
  Date.now = () => clock.now()

  let focusedNow = focused
  let focusCalls = 0
  let definition
  const dictionaries = {}
  const gestureHandlers = { pointerdown: [], keydown: [] }
  const canvasOps = []
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    localStorage: createStorage(storage),
    AudioContext: FakeAudioContext,
    addEventListener: (type, handler) => { (gestureHandlers[type] ??= []).push(handler) },
    removeEventListener: (type, handler) => {
      const list = gestureHandlers[type]
      if (list === undefined) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    focus: () => { focusCalls += 1 },
    setTimeout: (fn, delay) => clock.set(fn, delay),
  }
  const canvasContext = {
    beginPath: () => canvasOps.push('beginPath'),
    moveTo: () => canvasOps.push('moveTo'),
    arcTo: () => canvasOps.push('arcTo'),
    closePath: () => canvasOps.push('closePath'),
    clip: () => canvasOps.push('clip'),
    drawImage: () => canvasOps.push('drawImage'),
  }
  globalThis.document = {
    visibilityState: 'visible',
    hasFocus: () => focusedNow,
    createElement: (tag) => tag === 'canvas'
      ? {
          width: 0,
          height: 0,
          getContext: () => canvasContext,
          toDataURL: () => 'data:image/png;base64,ROUNDED',
        }
      : {},
  }
  if (notificationApi) globalThis.Notification = FakeNotification
  else delete globalThis.Notification
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-browser' }, configurable: true, writable: true })
  globalThis.Image = class {
    set src (value) { this.value = value }
    decode () { return Promise.resolve() }
  }

  new Function(source)()
  const plugin = definition.factory(() => fakeReact)

  let status = initialStatus ?? new Map()
  const statusListeners = new Set()
  const statusStore = {
    getSnapshot: () => status,
    subscribe: (listener) => {
      statusListeners.add(listener)
      return () => { statusListeners.delete(listener) }
    },
    set: (next) => {
      status = next
      for (const listener of [...statusListeners]) listener()
    },
  }

  let sessionRows = SESSIONS
  let phase = 'ready'
  const catalogListeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: sessionRows, phase }),
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
  const services = {}
  /** Sessions the plugin asked the workspace to open, in order. */
  const opened = []
  const uiWorkspace = withWorkspace ? { openSession: (sessionId) => { opened.push(sessionId) } } : undefined
  const ctx = {
    locale: {
      register: (namespace, dictionary) => {
        dictionaries[namespace] = dictionary
        return () => {}
      },
      bind: (namespace) => (key) => dictionaries[namespace]?.zh?.[key] ?? key,
    },
    slots: {
      inject: (owner, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({
          options,
          component,
          props: typeof options.inject === 'function' ? options.inject() : undefined,
        })
        return () => {}
      },
    },
    effect: (fn) => {
      const off = fn()
      cleanups.push(off)
    },
    inject: (deps, callback) => {
      const scope = {
        uiSession,
        sessions,
        effect: (fn) => {
          const off = fn()
          cleanups.push(off)
        },
      }
      callback(scope)
    },
    reflect: {
      provide: (name, value) => { services[name] = value },
    },
    // The Session-opening service belongs to another plugin, so it is looked up at click time
    // rather than injected; a catalog without it must not break the notifier.
    get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
  }

  plugin.apply(ctx)
  await new Promise((resolve) => realSetTimeout(resolve, 0))

  return {
    clock,
    statusStore,
    registrations,
    services,
    canvasOps,
    setSessionRows: (rows, { touch = true } = {}) => {
      sessionRows = rows
      if (touch) for (const listener of [...catalogListeners]) listener()
    },
    setPhase: (value) => { phase = value },
    setFocused: (value) => { focusedNow = value },
    /** Sessions the plugin asked the workspace to open. */
    opened,
    /** How many times the plugin tried to raise the window. */
    focusCalls: () => focusCalls,
    fireGesture: () => {
      for (const handler of [...gestureHandlers.pointerdown]) handler()
    },
    dispose: () => {
      for (const off of cleanups.reverse()) if (typeof off === 'function') off()
    },
    api: globalThis.window.__dshSessionNotifier,
    reminderAlias: globalThis.window.__dshReminder,
  }
}

const running = (id, extra = {}) => [id, { running: true, pendingInteraction: undefined, completionUnread: false, ...extra }]
const idle = (id, extra = {}) => [id, { running: false, pendingInteraction: undefined, completionUnread: false, ...extra }]
const snapshot = (...entries) => new Map(entries)

const question = (key, text) => ({ key, kind: 'question', questions: [{ question: text }] })
const planReview = (key, text) => ({ key, kind: 'plan-review', questions: [{ question: text }] })
const approval = (key, toolName, reason) => ({ key, kind: 'approval', toolName, reason })

const tones = () => audioContexts.reduce((sum, context) => sum + context.tones.length, 0)
const titles = () => notifications.map((item) => item.title)
const bodies = () => notifications.map((item) => item.options.body)

let failures = 0
async function check (name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('Session notifier decision table')

// ---------------------------------------------------------------- completion delivery

await check('turn end while away raises a sound and a desktop notification once the Session settles', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  assert.equal(notifications.length, 0, 'a turn boundary alone is not an alert yet')
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '会话已完成 · My session')
  assert.equal(bodies()[0], '这一轮已经结束，点开查看结果。')
  assert.ok(tones() > 0)
})

await check('the alert waits out the settle window instead of firing on the boundary', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(1000)
  assert.equal(notifications.length, 0)
  clock.advance(400)
  assert.equal(notifications.length, 1)
})

await check('a goal round that resumes the turn raises nothing', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  statusStore.set(snapshot(running('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('a whole round trip of a goal loop only alerts when it finally stops', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'active', 1) })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0, 'an active goal is not quiet yet')
  clock.advance(14000)
  assert.equal(notifications.length, 1)
})

await check('an active goal whose rounds keep advancing stays silent past the settle window', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'active', 1) })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'active', 2) })
  clock.advance(GOAL_QUIET_MS)
  assert.equal(notifications.length, 0)
})

await check('a goal round advanced without an observed running edge still counts as a continuation', async () => {
  const { statusStore, clock, setSessionRows } = await boot({ initialStatus: snapshot(idle('s1')) })
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'active', 2) })
  statusStore.set(snapshot(idle('s1', { completionUnread: true })))
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'active', 3) })
  clock.advance(GOAL_QUIET_MS)
  assert.equal(notifications.length, 0)
})

await check('a goal that completes is reported on the normal settle window', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'complete', 2) })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('a paused goal is reported on the normal settle window', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'paused', 2) })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('a blocked goal is reported on the normal settle window', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ s1: withGoal(SESSIONS.s1, 'blocked', 2) })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('a queued follow-up that resumes the turn raises nothing', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(500)
  statusStore.set(snapshot(running('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('a Session that never resumes is reported once, not once per re-check', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('an unread completion is alerted even without an observed running edge', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(idle('s1')))
  statusStore.set(snapshot(idle('s1', { completionUnread: true })))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('state already unread at install time is not alerted, and the next one is', async () => {
  const { statusStore, clock } = await boot({ initialStatus: snapshot(idle('s1', { completionUnread: true })) })
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1', { completionUnread: true })))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('a completion during a reconnect baseline is not offered', async () => {
  const { statusStore, clock, setPhase } = await boot()
  setPhase('pending')
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  setPhase('ready')
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

// ---------------------------------------------------------------- interaction delivery

await check('a question alert is delivered immediately, without waiting for any window', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'Continue?'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '需要你回答 · My session')
  assert.equal(bodies()[0], 'Continue?')
})

await check('an approval alert carries the tool and the reason, immediately', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: approval('a1', 'Bash', 'rm -rf build'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '需要你批准 · My session')
  assert.equal(bodies()[0], 'Bash · rm -rf build')
})

await check('a plan review alert uses its own heading', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: planReview('p1', 'Does this plan work?'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '需要你确认计划 · My session')
  assert.equal(bodies()[0], 'Does this plan work?')
})

await check('the same interaction key is not alerted twice, a replacement is', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'first'), completionUnread: false } ]))
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'first'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q2', 'second'), completionUnread: false } ]))
  assert.equal(notifications.length, 2)
})

await check('a pending interaction replaces the completion alert for that Session', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'waiting'), completionUnread: false } ]))
  clock.advance(SETTLE_MS * 2)
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '需要你回答 · My session')
})

// ---------------------------------------------------------------- child Sessions

await check('a child Session finishing its own turn raises nothing by default', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('sub1')))
  statusStore.set(snapshot(idle('sub1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('a parentId child Session finishing raises nothing by default', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('child1')))
  statusStore.set(snapshot(idle('child1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('child completions alert once enabled, labelled as a Subagent', async () => {
  const { api, statusStore, clock } = await boot()
  api.setChildCompletions(true)
  statusStore.set(snapshot(running('sub1')))
  statusStore.set(snapshot(idle('sub1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '会话已完成 · 子代理 researcher')
})

await check('a child that stops to ask still alerts by default, labelled as a Subagent', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 'sub1', { running: false, pendingInteraction: question('q1', 'which option?'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  assert.equal(titles()[0], '需要你回答 · 子代理 researcher')
})

await check('child interactions can be switched off', async () => {
  const { api, statusStore } = await boot()
  api.setChildInteractions(false)
  statusStore.set(snapshot([ 'sub1', { running: false, pendingInteraction: question('q1', 'which option?'), completionUnread: false } ]))
  assert.equal(notifications.length, 0)
})

// ---------------------------------------------------------------- clicking and retiring toasts

await check('clicking a notification opens the Session it is about and raises the window', async () => {
  const { statusStore, clock, opened, focusCalls } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
  notifications[0].onclick()
  assert.deepEqual(opened, ['s1'], 'the toast opens the Session it reports')
  assert.ok(focusCalls() >= 1, 'the window is asked to come forward')
})

await check('clicking an interaction notification opens its Session too', async () => {
  const { statusStore, opened } = await boot()
  statusStore.set(snapshot([ 's2', { running: false, pendingInteraction: question('q1', 'which one?'), completionUnread: false } ]))
  assert.equal(notifications.length, 1)
  notifications[0].onclick()
  assert.deepEqual(opened, ['s2'])
})

await check('a missing workspace service does not break the click', async () => {
  // The Session-opening service belongs to another plugin; a page without it must still be able
  // to dismiss the toast, and the click must not throw.
  const { statusStore, clock } = await boot({ withWorkspace: false })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
  notifications[0].onclick()
  assert.equal(notifications[0].closed, true, 'the toast is still retired')
})

await check('a manual test notification opens nothing: it names no Session', async () => {
  const { api, opened } = await boot()
  api.test('completion')
  assert.equal(notifications.length, 1)
  notifications[0].onclick()
  assert.deepEqual(opened, [])
})

// ---------------------------------------------------------------- focus and watching

await check('the same Session is not alerted while focused on screen', async () => {
  const { statusStore, clock } = await boot({ current: 's1' })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('the focus check happens at delivery time, not when the turn ended', async () => {
  const { statusStore, clock, setFocused } = await boot({ focused: false, current: 's1' })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  setFocused(true)
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
})

await check('an unfocused window alerts for the Session on screen', async () => {
  const { statusStore, clock } = await boot({ focused: false, current: 's1' })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('another Session still alerts while one is on screen', async () => {
  const { statusStore, clock } = await boot({ current: 's2' })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('skipFocused=false alerts even while watching', async () => {
  const { statusStore, clock, api } = await boot({ current: 's1' })
  api.setSkipFocused(false)
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
})

await check('a tracked interaction while watching is skipped too', async () => {
  const { statusStore } = await boot({ current: 's1' })
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'on screen'), completionUnread: false } ]))
  assert.equal(notifications.length, 0)
})

// ---------------------------------------------------------------- channels and OS rules

await check('sound=false keeps the notification and drops the chime', async () => {
  const { statusStore, clock, api } = await boot()
  api.setSound(false)
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 1)
  assert.equal(tones(), 0)
})

await check('desktop=false keeps the sound and drops the notification', async () => {
  const { statusStore, clock, api } = await boot()
  api.setDesktop(false)
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.ok(tones() > 0)
})

await check('a denied permission suppresses desktop notifications but not the sound', async () => {
  const { statusStore, clock } = await boot({ permission: 'denied', current: undefined })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.ok(tones() > 0)
})

await check('an environment without the Notification API keeps the sound', async () => {
  const { statusStore, clock } = await boot({ notificationApi: false })
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.ok(tones() > 0)
})

await check('the master switch silences everything', async () => {
  const { statusStore, clock, api } = await boot()
  api.setEnabled(false)
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.equal(tones(), 0)
})

await check('a burst of completions is capped', async () => {
  const { statusStore, clock, setSessionRows } = await boot()
  setSessionRows({ ...SESSIONS })
  statusStore.set(snapshot(running('s1'), running('s2'), running('s3'), running('s4'), running('s5'), running('s6')))
  statusStore.set(snapshot(idle('s1'), idle('s2'), idle('s3'), idle('s4'), idle('s5'), idle('s6')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 4)
})

await check('a second alert in the same Session retires the old notification and uses a fresh short tag', async () => {
  const { statusStore, clock } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  const first = notifications[0]
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  const second = notifications[1]
  assert.equal(first.closed, true)
  assert.notEqual(first.options.tag, second.options.tag)
  assert.ok(second.options.tag.length <= 16)
  assert.equal(second.options.requireInteraction, true)
  assert.equal(second.options.silent, true)
})

await check('the notification icon is the rounded rendered PNG', async () => {
  const { statusStore, clock, canvasOps } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(notifications[0].options.icon, 'data:image/png;base64,ROUNDED')
  assert.ok(canvasOps.filter((op) => op === 'arcTo').length >= 4)
  assert.ok(canvasOps.indexOf('clip') < canvasOps.indexOf('drawImage'))
})

await check('probe does not create an audio context just by being read', async () => {
  const { api } = await boot()
  assert.equal(api.probe().audio, 'not-created-yet')
  assert.equal(audioContexts.length, 0)
})

await check('a long custom title cannot lengthen the toast tag', async () => {
  const { api, statusStore } = await boot()
  const long = `<b>${'span '.repeat(12)}</b> · {session}`
  api.setTitleTemplate('question', long)
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'one'), completionUnread: false } ]))
  statusStore.set(snapshot([ 's2', { running: false, pendingInteraction: question('q2', 'two'), completionUnread: false } ]))
  const tags = notifications.map((item) => item.options.tag)
  assert.ok(tags.every((tag) => tag.length <= 16))
  assert.equal(new Set(tags).size, tags.length)
})

await check('the tag is unique and short across alerts', async () => {
  const { statusStore } = await boot()
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'one'), completionUnread: false } ]))
  statusStore.set(snapshot([ 's2', { running: false, pendingInteraction: question('q2', 'two'), completionUnread: false } ]))
  const tags = notifications.map((item) => item.options.tag)
  assert.equal(new Set(tags).size, tags.length)
  assert.ok(tags.every((tag) => tag.length <= 16))
})

// ---------------------------------------------------------------- settings and migration

await check('defaults match the merged policy', async () => {
  const { api } = await boot()
  assert.deepEqual(api.getSettings(), {
    enabled: true,
    sound: true,
    desktop: true,
    skipFocused: true,
    childCompletions: false,
    childInteractions: true,
    titles: {},
  })
})

await check('settings persist to dsh.session-notifier.v2', async () => {
  const { api } = await boot()
  api.setSettings({ sound: false, titles: { question: 'Ask · {session}' } })
  const stored = JSON.parse(globalThis.window.localStorage.getItem('dsh.session-notifier.v2'))
  assert.equal(stored.sound, false)
  assert.equal(stored.titles.question, 'Ask · {session}')
})

await check('the desktop predecessor settings are migrated', async () => {
  const { api } = await boot({
    storage: {
      'dsh.session-notifier.v1': JSON.stringify({ sound: false, desktop: false, skipFocused: false }),
    },
  })
  const settings = api.getSettings()
  assert.equal(settings.sound, false)
  assert.equal(settings.desktop, false)
  assert.equal(settings.skipFocused, false)
  assert.ok(globalThis.window.localStorage.getItem('dsh.session-notifier.v2') !== null)
})

await check('the server predecessor settings are migrated, including titles and subagent policy', async () => {
  const { api } = await boot({
    storage: {
      'dsh-reminder:settings': JSON.stringify({
        enabled: false,
        sound: true,
        desktop: true,
        subagents: false,
        onlyWhenAway: true,
        titles: { done: '收工：{session}' },
      }),
    },
  })
  const settings = api.getSettings()
  assert.equal(settings.enabled, false)
  assert.equal(settings.skipFocused, true)
  assert.equal(settings.childCompletions, false)
  assert.equal(settings.childInteractions, false)
  assert.equal(settings.titles.done, '收工：{session}')
})

await check('resetSettings restores every default and clears overrides', async () => {
  const { api } = await boot()
  api.setChildCompletions(true)
  api.setTitleTemplate('done', '收工 {session}')
  api.resetSettings()
  assert.deepEqual(api.getSettings(), {
    enabled: true,
    sound: true,
    desktop: true,
    skipFocused: true,
    childCompletions: false,
    childInteractions: true,
    titles: {},
  })
})

await check('a custom title template is rendered with the session name', async () => {
  const { api, statusStore } = await boot()
  api.setTitleTemplate('question', '【{session}】来消息了')
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'hi'), completionUnread: false } ]))
  assert.equal(titles()[0], '【My session】来消息了')
})

await check('an empty template falls back to the locale default', async () => {
  const { api, statusStore } = await boot()
  api.setTitleTemplate('question', 'custom {session}')
  api.setTitleTemplate('question', '')
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'hi'), completionUnread: false } ]))
  assert.equal(titles()[0], '需要你回答 · My session')
})

await check('each title slot is independent', async () => {
  const { api, statusStore, clock } = await boot()
  api.setTitleTemplate('done', '收工：{session}')
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  clock.advance(SETTLE_MS)
  assert.equal(titles()[0], '收工：My session')
})

await check('a session-less manual test drops the dangling placeholder', async () => {
  const { api } = await boot()
  api.test('interaction')
  assert.equal(titles()[0], '需要你回答')
  assert.equal(bodies()[0], '这是 session-notifier 的测试提醒。')
})

await check('manual test completion uses the done title and the test body', async () => {
  const { api } = await boot()
  api.test('done')
  assert.equal(titles()[0], '会话已完成')
  assert.equal(bodies()[0], '这是 session-notifier 的测试提醒。')
})

// ---------------------------------------------------------------- Settings page

await check('the Settings page is registered as both a section and a plugin tab', async () => {
  const { registrations } = await boot()
  const section = registrations.find((entry) => entry.options.name === 'settings.section')
  const tab = registrations.find((entry) => entry.options.name === 'settings.plugins.tab')
  assert.ok(section !== undefined && tab !== undefined)
  assert.equal(section.options.id, 'session-notifier')
  assert.equal(tab.options.id, 'session-notifier')
  assert.equal(section.options.label(), '会话提醒')
})

await check('the Settings page renders every switch, template input and action', async () => {
  const { registrations } = await boot()
  const registration = registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = registration.component({
    ...registration.props,
    t: (key) => key,
  })
  const switches = []
  const inputs = []
  const buttons = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'button') {
      if (node.props?.role === 'switch') switches.push(node)
      else buttons.push(node)
    }
    if (node.type === 'input') inputs.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  assert.equal(switches.length, 6)
  assert.equal(inputs.length, 4)
  assert.equal(buttons.length, 5)
  assert.deepEqual(inputs.map((input) => input.props.placeholder), [
    'title.question',
    'title.planReview',
    'title.approval',
    'title.done',
  ])
})

await check('toggling a switch writes through to settings', async () => {
  const { registrations, api } = await boot()
  const registration = registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = registration.component({ ...registration.props, t: (key) => key })
  const switches = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'button' && node.props?.role === 'switch') switches.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  switches[3].props.onClick()
  assert.equal(api.getSettings().skipFocused, false)
})

await check('editing a template input persists it', async () => {
  const { registrations, api } = await boot()
  const registration = registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = registration.component({ ...registration.props, t: (key) => key })
  const inputs = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'input') inputs.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  inputs[0].props.onChange({ target: { value: 'X {session}' } })
  assert.equal(api.getSettings().titles.question, 'X {session}')
})

await check('the reset and test buttons work from the page', async () => {
  const { registrations, api } = await boot()
  const registration = registrations.find((entry) => entry.options.name === 'settings.section')
  const tree = registration.component({ ...registration.props, t: (key) => key })
  const buttons = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'button' && node.props?.role !== 'switch') buttons.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  const byLabel = (label) => buttons.find((button) => button.children?.[0] === label)
  api.setTitleTemplate('done', 'x {session}')
  byLabel('action.reset').props.onClick()
  assert.equal(api.getSettings().titles.done, undefined)
  const before = notifications.length
  byLabel('action.test').props.onClick()
  byLabel('action.testDone').props.onClick()
  assert.equal(notifications.length, before + 2)
})

// ---------------------------------------------------------------- console/service face

await check('the console hook and the service face expose the same API', async () => {
  const { api, reminderAlias, services } = await boot()
  assert.ok(typeof api?.probe === 'function')
  assert.equal(reminderAlias, api)
  assert.equal(services.sessionNotifier, api)
  const probe = api.probe()
  assert.equal(probe.loaded, true)
  assert.equal(probe.icon, 'ready')
  assert.equal(probe.environment, 'browser')
  assert.equal(typeof probe.permission, 'string')
})

await check('the first gesture asks for permission exactly once', async () => {
  const { fireGesture } = await boot({ permission: 'default' })
  fireGesture()
  fireGesture()
  assert.equal(permissionRequests, 1)
})

await check('a suspended audio context is resumed instead of throwing', async () => {
  const { statusStore, fireGesture } = await boot()
  fireGesture()
  audioContexts[0].state = 'suspended'
  statusStore.set(snapshot([ 's1', { running: false, pendingInteraction: question('q1', 'hi'), completionUnread: false } ]))
  await new Promise((resolve) => realSetTimeout(resolve, 0))
  assert.equal(audioContexts[0].state, 'running')
  assert.ok(tones() > 0)
})

await check('disposing the plugin cancels a pending completion and removes the hooks', async () => {
  const { statusStore, clock, dispose } = await boot()
  statusStore.set(snapshot(running('s1')))
  statusStore.set(snapshot(idle('s1')))
  dispose()
  clock.advance(SETTLE_MS)
  assert.equal(notifications.length, 0)
  assert.equal(globalThis.window.__dshSessionNotifier, undefined)
  assert.equal(globalThis.window.__dshReminder, undefined)
})

console.log(failures === 0
  ? '\nall checks passed'
  : `\n${String(failures)} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
