/**
 * Behavioral test for dsh-reminder's browser half.
 *
 * Loads the REAL client/client.js, gives it a stub browser (Web Audio +
 * Notification) and a stub Client context whose `uiSession.sessionStatus`
 * snapshot the test drives step by step, then asserts exactly which
 * transitions produce a reminder through which channel.
 *
 * What this proves: silent first snapshot, pending-request dedupe by key,
 * completion on the session's own running true → false (even for the main
 * view), a row first seen already-unread staying silent, single fire when both
 * completion signals arrive together, the "only when away" option, the
 * baseline-phase gate, subagent filtering, degradation on denied permission
 * and on a suspended audio context, the one-time permission ask, and the
 * manual hooks.
 *
 * What this does NOT prove: real audio output and real desktop notifications —
 * those need the running GUI.
 *
 * Run: node test/reminder.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const dom = new JSDOM(
  '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head><body></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' },
)
const { window } = dom
for (const key of ['window', 'document', 'navigator', 'HTMLInputElement', 'Element', 'Node', 'HTMLCanvasElement']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
const tick = () => new Promise(resolveTick => { setTimeout(resolveTick, 30) })

// ---- stub the favicon rasterization path ------------------------------------
// The shell ships an SVG favicon; the plugin fetches and rasterizes it. These
// stubs stand in for fetch/Image/canvas so the success and fallback paths are
// both observable.
const PNG = 'data:image/png;base64,ICON'
class FakeImage {
  set src(value) { this.value = value }
  decode() { return Promise.resolve() }
}
Object.defineProperty(globalThis, 'Image', { value: FakeImage, configurable: true, writable: true })
window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: () => {} })
window.HTMLCanvasElement.prototype.toDataURL = () => PNG
Object.defineProperty(globalThis.URL, 'createObjectURL', { value: () => 'blob:stub', configurable: true, writable: true })
Object.defineProperty(globalThis.URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true })
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }) })

// ---- stub browser facilities -------------------------------------------------
const audio = { contexts: 0, resumes: 0, oscillators: [], instance: null }
class FakeAudioContext {
  constructor() {
    audio.contexts += 1
    this.state = 'running'
    this.currentTime = 0
    this.destination = { kind: 'destination' }
    audio.instance = this
  }

  resume() {
    audio.resumes += 1
    this.state = 'running'
    return Promise.resolve()
  }

  createOscillator() {
    const oscillator = { type: '', frequency: { value: 0 }, connect: (target) => target, start: () => {}, stop: () => {} }
    audio.oscillators.push(oscillator)
    return oscillator
  }

  createGain() {
    return {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (target) => target,
    }
  }
}
window.AudioContext = FakeAudioContext

const notifications = []
let permissionRequests = 0
class FakeNotification {
  static permission = 'granted'
  static requestPermission() {
    permissionRequests += 1
    return Promise.resolve(FakeNotification.permission)
  }

  constructor(title, options) {
    notifications.push({ title, options })
    this.onclick = null
  }

  close() {}
}
Object.defineProperty(globalThis, 'Notification', { value: FakeNotification, configurable: true, writable: true })

// ---- load the plugin under test ---------------------------------------------
// The bundle reads `window` (AudioContext, focus, the debug hook), so hand it
// the real jsdom window carrying the registration facade.
let registration
window.__ModuleLoader__ = { load(value) { registration = value } }
new Function('window', readFileSync(resolve(here, '../client/client.js'), 'utf8'))(window)
if (registration?.id !== 'dsh-reminder') throw new Error(`unexpected registration: ${String(registration?.id)}`)
/** Platform-module stub: React and the host button atom, enough to render the settings tab. */
const requireStub = (spec) => {
  if (spec === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: function Button(props) { return { type: 'Button', props } } }
  }
  throw new Error(`unexpected require: ${spec}`)
}
const plugin = registration.factory(requireStub)

// ---- stub Client context -----------------------------------------------------
const CATALOG = [
  ['s1', { displayTitle: '会话一' }],
  ['s2', { displayTitle: '会话二' }],
  ['s3', { displayTitle: '会话三' }],
  ['s4', { displayTitle: '子代理', origin: 'subagent' }],
  ['s5', { displayTitle: '会话五' }],
  ['s6', { displayTitle: '会话六' }],
  ['s7', { displayTitle: '会话七' }],
  ['s8', { displayTitle: '会话八' }],
  ['s10', { displayTitle: '会话十' }],
  ['sNew', { displayTitle: '新会话' }],
]
const rows = (phase = 'ready') => ({
  byId: Object.fromEntries(CATALOG),
  ids: CATALOG.map(([id]) => id),
  phase,
})
let listState = rows()
let statusSnapshot = new Map()
let statusListener = null
const cleanups = []
const warnings = []
/** Slot registrations the plugin makes (the Plugins-section settings tab). */
const tabRegistrations = []
const fakeCtx = {
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return () => {}
  },
  get: () => undefined,
  reflect: { provide() {} },
  logger: { warn: (message) => warnings.push(message) },
  slots: {
    inject: (key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      tabRegistrations.push({ options, component })
      return () => {}
    },
  },
  sessions: { list: { getSnapshot: () => listState, subscribe: () => () => {} } },
  uiSession: {
    sessionStatus: {
      getSnapshot: () => statusSnapshot,
      subscribe: (listener) => {
        statusListener = listener
        return () => { statusListener = null }
      },
    },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
}
plugin.apply(fakeCtx)
const reminder = window.__dshReminder
// Icon resolution runs at activation; let it settle before asserting on it.
await tick()

// ---- harness -----------------------------------------------------------------
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}
const live = new Map()
const status = (over = {}) => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...over })
const flush = () => {
  statusSnapshot = new Map(live)
  statusListener?.()
}
/** Adopt one session's new status as the next snapshot (one flush = one snapshot). */
const put = (id, over = {}) => {
  live.set(id, status(over))
  flush()
}
const putAll = (entries) => {
  for (const [id, over] of entries) live.set(id, status(over))
  flush()
}
const question = (key, text) => ({ kind: 'question', key, questions: [{ question: text }] })
const planReview = (key, text) => ({ kind: 'plan-review', key, questions: [{ question: text }] })
const approval = (key, toolName, reason) => ({ kind: 'approval', key, toolName, reason })
const oscCount = () => audio.oscillators.length
const fired = () => reminder.describe().fired

check('apply exposed the manual hooks', typeof reminder?.test === 'function' && typeof reminder?.probe === 'function')
check('defaults: enabled, sound on, desktop on, subagents off, not only-when-away',
  reminder.isEnabled() && reminder.isSoundEnabled() && reminder.isDesktopEnabled()
  && !reminder.areSubagentsEnabled() && !reminder.isOnlyWhenAway())
check('notification permission is readable', reminder.notificationPermission() === 'granted')
check('the page favicon is rasterized into notification icon bytes',
  reminder.probe().icon === 'ready' && String(reminder.probe().iconUrl).startsWith('data:image/png'),
  JSON.stringify({ icon: reminder.probe().icon, iconUrl: reminder.probe().iconUrl }))

// ---- pre-existing facts are adopted silently --------------------------------
putAll([
  ['s1', { pendingInteraction: question('question:1', '旧问题') }],
  ['s2', { completionUnread: true }],
])
check('pre-existing facts do not remind', fired() === 0, `fired=${String(fired())}`)
check('the first snapshot primes the engine', reminder.probe().primed === true)

// ---- a NEW pending question reminds -----------------------------------------
put('s3', { pendingInteraction: question('question:2', '你确定要继续吗？') })
check('a new question reminds once', fired() === 1, `fired=${String(fired())}`)
check('the needs-you chime is three notes', oscCount() === 3, `oscillators=${String(oscCount())}`)
check('the desktop notification names the session and carries the question',
  notifications.length === 1
  && notifications[0].title === '❓ 需要你回答 · 会话三'
  && notifications[0].options.body === '你确定要继续吗？',
  JSON.stringify(notifications[0] ?? null))
check('the desktop notification carries the DSH icon', notifications[0]?.options.icon === PNG, String(notifications[0]?.options.icon))

// ---- churn on the same request does not remind again ------------------------
put('s1', { running: true, pendingInteraction: question('question:1', '旧问题') })
put('s3', { running: true, pendingInteraction: question('question:2', '你确定要继续吗？') })
check('the same pending key does not remind again', fired() === 1, `fired=${String(fired())}`)

// ---- a replacement request reminds again ------------------------------------
put('s3', { pendingInteraction: approval('approval:9', 'Bash', 'rm -rf build') })
check('a replacement request reminds again', fired() === 2, `fired=${String(fired())}`)
check('approval wording carries the reason',
  notifications[1]?.title === '🔐 需要你批准 · 会话三' && notifications[1]?.options.body === 'rm -rf build',
  JSON.stringify(notifications[1] ?? null))

// ---- a turn that stops reminds even while you watch that session ------------
const beforeDone = oscCount()
put('s3', { running: true })
put('s3', { running: false })
check('a stopped turn reminds (no unread fact needed)', fired() === 3, `fired=${String(fired())}`)
check('the done chime is two notes', oscCount() === beforeDone + 2, `oscillators=${String(oscCount())}`)
check('done wording', notifications[2]?.title === '✅ 会话已完成 · 会话三', String(notifications[2]?.title))

// ---- a row first seen already-unread is a replay, not a stop ----------------
put('sNew', { completionUnread: true })
check('a row first seen already-unread stays silent', fired() === 3, `fired=${String(fired())}`)

// ---- both completion signals for one stop fire exactly once -----------------
put('s10', { running: true })
put('s10', { running: false, completionUnread: true })
check('a stop reported by both signals reminds once', fired() === 4, `fired=${String(fired())}`)

// ---- subagent completions are filtered by default ---------------------------
put('s4', { running: true })
put('s4', { running: false })
check('a finished subagent does not remind by default', fired() === 4, `fired=${String(fired())}`)
reminder.setSubagents(true)
put('s4', { running: true })
put('s4', { running: false })
check('a finished subagent reminds once enabled', fired() === 5, `fired=${String(fired())}`)
reminder.setSubagents(false)

// ---- onlyWhenAway narrows completions to the Client's unread signal ---------
reminder.setOnlyWhenAway(true)
put('s5', { running: true })
put('s5', { running: false })
check('onlyWhenAway suppresses the watched completion', fired() === 5, `fired=${String(fired())}`)
put('s5', { completionUnread: true })
check('onlyWhenAway still reminds for an unread completion', fired() === 6, `fired=${String(fired())}`)
reminder.setOnlyWhenAway(false)

// ---- a reconnect baseline must not ring ------------------------------------
listState = rows('pending')
put('s6', { running: true })
put('s6', { running: false })
check('a stop during the baseline phase does not remind', fired() === 6, `fired=${String(fired())}`)
listState = rows()
put('s6', { running: true })
put('s6', { running: false })
check('the same stop reminds once the list is ready', fired() === 7, `fired=${String(fired())}`)

// ---- denied permission still chimes, constructs nothing ---------------------
FakeNotification.permission = 'denied'
const notificationsBefore = notifications.length
put('s7', { pendingInteraction: question('question:7', '还有问题') })
check('denied permission still chimes', fired() === 8, `fired=${String(fired())}`)
check('denied permission constructs no notification', notifications.length === notificationsBefore)
FakeNotification.permission = 'granted'

// ---- a suspended context degrades to resume(), never a throw -----------------
audio.resumes = 0
audio.instance.state = 'suspended'
put('s8', { pendingInteraction: planReview('question:8', '计划可以吗') })
check('a suspended context resumes instead of throwing', audio.resumes === 1 && fired() === 9, `resumes=${String(audio.resumes)} fired=${String(fired())}`)
check('plan review wording', String(notifications.at(-1)?.title).includes('需要你确认计划'), String(notifications.at(-1)?.title))

// ---- the first gesture asks for permission exactly once --------------------
permissionRequests = 0
FakeNotification.permission = 'default'
window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
check('permission is requested exactly once', permissionRequests === 1, `requests=${String(permissionRequests)}`)
FakeNotification.permission = 'granted'

// ---- manual hooks ----------------------------------------------------------
const beforeTest = fired()
reminder.test('done')
reminder.test()
check('the console test hook fires both kinds', fired() === beforeTest + 2, `fired=${String(fired())}`)
check('test reminders are labelled as tests', String(notifications.at(-1)?.options.body).includes('测试'), String(notifications.at(-1)?.options.body))
check('probe reports a usable diagnosis', reminder.probe().loaded === true
  && reminder.probe().fired === fired()
  && reminder.probe().permission === 'granted'
  && ['running', 'suspended', 'closed'].includes(reminder.probe().audio),
  JSON.stringify(reminder.probe()))

// ---- the plugin's own settings page ----------------------------------------
const tab = tabRegistrations.find(entry => entry.options.name === 'settings.plugins.tab')
check('the plugin registers a settings tab in the Plugins section',
  tab !== undefined && tab.options.id === 'dsh-reminder' && tab.options.locale === 'dsh-reminder',
  JSON.stringify(tab?.options ?? null))
check('the tab label is localized', tab?.options.label() === '提醒', String(tab?.options.label?.()))
const nav = tabRegistrations.find(entry => entry.options.name === 'settings.section')
check('the plugin also has its own Settings nav row', nav !== undefined && nav.options.id === 'dsh-reminder',
  JSON.stringify(nav?.options ?? null))
check('the nav row label is localized', nav?.options.label() === '提醒', String(nav?.options.label?.()))
const tree = tab.component({ t: (key) => key })
const actions = tree.children[1]
check('the settings page renders the test buttons',
  actions.type === 'div' && actions.children.length === 2
  && actions.children.every(child => typeof child.props?.onClick === 'function' && typeof child.props?.variant === 'string')
  && actions.children[0].props.variant === 'primary',
  JSON.stringify(actions.children.map(child => child.props?.variant ?? null)))
const firedBeforeButtons = fired()
actions.children[0].props.onClick()
actions.children[1].props.onClick()
check('the test buttons fire both reminder kinds', fired() === firedBeforeButtons + 2, `fired=${String(fired())}`)
check('the settings page shows a live status line',
  typeof tree.children[2].children[0] === 'string'
  && tree.children[2].children[0].includes('statusPermission')
  && tree.children[2].children[0].includes('statusAudio'),
  String(tree.children[2].children[0]))

// ---- disposal --------------------------------------------------------------
for (const cleanup of cleanups.reverse()) cleanup()
check('dispose removed the console hook', window.__dshReminder === undefined)
const afterDispose = notifications.length
put('s7', { running: true })
put('s7', { running: false, completionUnread: true })
put('s7', { pendingInteraction: question('question:99', '不应提醒') })
check('disposed engine stops reminding', notifications.length === afterDispose)
check('apply logged no warnings', warnings.length === 0, warnings.join('; '))

// ---- a failed rasterization still supplies the page's own icon --------------
// A second instance of the same bundle (fresh closure) with fetch failing: the
// resolution must fall back to the favicon's own URL rather than dropping the
// icon entirely.
globalThis.fetch = async () => { throw new Error('offline') }
let secondListener = null
const secondSnapshot = { value: new Map() }
registration.factory(requireStub).apply({
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
  reflect: { provide() {} },
  logger: { warn: () => {} },
  slots: { inject: (key, callback) => { callback(); return () => {} }, register: () => () => {} },
  sessions: { list: { getSnapshot: () => rows(), subscribe: () => () => {} } },
  uiSession: {
    sessionStatus: {
      getSnapshot: () => secondSnapshot.value,
      subscribe: (listener) => {
        secondListener = listener
        return () => { secondListener = null }
      },
    },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
})
await tick()
const beforeFallback = notifications.length
secondSnapshot.value = new Map()
secondListener()
secondSnapshot.value = new Map([['s1', { running: false, pendingInteraction: question('question:1', '回退问题'), completionUnread: false }]])
secondListener()
check('a failed rasterization still supplies the raw page icon',
  notifications.length === beforeFallback + 1 && notifications.at(-1)?.options.icon === 'http://localhost/favicon.svg',
  String(notifications.at(-1)?.options.icon))

console.log(failures.length === 0
  ? '\nall checks passed'
  : `\n${String(failures.length)} check(s) failed:\n- ${failures.join('\n- ')}`)
process.exit(failures.length === 0 ? 0 : 1)
