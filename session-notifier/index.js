/**
 * Host half of the Session notifier bundle.
 *
 * Everything about *when* to alert and *how* to deliver it lives in the browser
 * half (`client.js`, declared by `dsh.client` in package.json). One thing the
 * page cannot do is bring its own operating-system window to the front: Windows
 * refuses a foreground grab from a background renderer, and the desktop shell
 * exposes no window-activation IPC to the page. So the page asks this half.
 *
 * The desktop shell runs this Host as a Node-mode child process, which means:
 *
 *   - `import('electron')` is useless here (no Electron APIs outside the main
 *     process), so the window work goes through Win32 directly;
 *   - `process.ppid` is the Electron main process — the one that owns the
 *     window — so the raise can name its target exactly instead of guessing
 *     among several running DSH instances;
 *   - the shell's IPC channel is a closed whitelist (`ready`, `platform-session`,
 *     `update-tasks`, `quit-inspection`, …); an unknown message makes the shell
 *     treat the Host as broken. Nothing here talks to the shell over IPC.
 *
 * Every attempt is appended to `<dsh home>/session-notifier-raise.log`, because
 * this path has no other observable surface: the page cannot render a failure,
 * and a raise that quietly does nothing looks exactly like a click that never
 * asked. The log carries the gate verdict, the spawn outcome, the script's exit
 * code and the foreground check, which is enough to tell those apart.
 *
 * The whole window work is Windows-only.
 *
 * CROSS-DEVICE DISMISSAL
 * A desktop notification lives in the page that created it, so handling a
 * Session on one device leaves every other device's toast claiming the Session
 * still waits for the user. The same Host therefore keeps one process-wide
 * "handled" hub:
 *
 *   - `POST /plugin/session-notifier/handled` publishes that one Session was
 *     just handled (answered, approved, opened, taken over);
 *   - `GET /plugin/session-notifier/handled-events` streams those records. An
 *     `Accept: text/event-stream` client gets SSE (with `Last-Event-ID`
 *     replay); a plain fetch client gets a bounded long-poll, so the same route
 *     works in the browser and in the Desktop shell.
 *
 * Both routes sit behind the same `connection.requestRejection` fence as the
 * raise route, so an unauthenticated or cross-site caller never publishes.
 * The hub is process-local: it reaches every page talking to this DSH instance,
 * not other DSH servers.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name; the bundle patch and the browser registration share it. */
export const name = 'session-notifier'

/** Route the browser half POSTs to when the user clicked a notification. */
export const RAISE_ROUTE = '/plugin/session-notifier/raise-window'

/** Route publishing "this Session was just handled" to every connected page. */
export const HANDLED_ROUTE = '/plugin/session-notifier/handled'
/** Stream of handled Sessions, replayed for a reconnecting page. */
export const HANDLED_EVENTS_ROUTE = '/plugin/session-notifier/handled-events'

/** @returns the diagnostic trail path; a path with no other observable surface. */
export function raiseLogPath () {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-notifier-raise.log')
}

/** @returns the local time to millisecond precision, for the log. */
function stamp () {
  return new Date().toISOString()
}

/**
 * Append one diagnostic line; logging must never break the route.
 * @param entry - fields to record.
 */
export function recordRaise (entry) {
  try {
    appendFileSync(raiseLogPath(), `${JSON.stringify({ at: stamp(), ...entry })}\n`, 'utf8')
  } catch {
    /* a read-only home directory costs the log, not the feature */
  }
}

/**
 * PowerShell performing the raise: a topmost toggle plus a foreground grab,
 * re-asserted a few times because the shell may fight the activation right
 * after a toast click.
 *
 * Why each step is there:
 *
 *   - `SetForegroundWindow` is refused while another process owns the
 *     foreground. Raising a **topmost** window is allowed, so the window is made
 *     topmost for an instant and then released with `HWND_NOTOPMOST` — it keeps
 *     the front position it was just given without staying pinned above
 *     everything.
 *   - Windows only grants foreground rights to the thread that owns the
 *     foreground window. Synthesising a bare Alt press is the long-standing way
 *     to hand those rights over (the same trick DSH's own native directory
 *     picker uses before showing its dialog).
 *   - `AttachThreadInput` and `SwitchToThisWindow` are the fallbacks when the
 *     Alt press was not enough.
 *   - The assertion is repeated: one grab can be undone by the shell activating
 *     its own window right after the toast click.
 *   - The final check reports whether the window really is in front, so "started"
 *     and "succeeded" never get confused.
 *
 * The target is the shell process that owns the window — this Host's parent
 * (`process.ppid`) — so several DSH instances on one machine cannot raise each
 * other's window.
 * @param pid - process id whose main window should come forward.
 * @returns a PowerShell script; exit 0 means the window is in front.
 */
export function raiseScript (pid) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SessionNotifier -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr hWnd, bool altTab);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, System.IntPtr processId);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$process = Get-Process -Id ${String(pid)} -ErrorAction Stop
$target = $process.MainWindowHandle
if ($target -eq [IntPtr]::Zero) {
  for ($i = 0; $i -lt 20 -and $target -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    $target = $process.MainWindowHandle
  }
}
if ($target -eq [IntPtr]::Zero) { exit 1 }

if ([SessionNotifier.Native]::IsIconic($target)) { [void][SessionNotifier.Native]::ShowWindow($target, 9) }

# SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
$show = 0x0001 -bor 0x0002 -bor 0x0040
[void][SessionNotifier.Native]::SetWindowPos($target, [IntPtr](-1), 0, 0, 0, 0, $show)

# Synthesised bare Alt press: hands foreground rights to this process.
[SessionNotifier.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[SessionNotifier.Native]::keybd_event(0x12, 0, 0x0002, [UIntPtr]::Zero)

for ($attempt = 0; $attempt -lt 4; $attempt++) {
  if ([SessionNotifier.Native]::GetForegroundWindow() -eq $target) { break }

  [void][SessionNotifier.Native]::BringWindowToTop($target)
  [void][SessionNotifier.Native]::SetForegroundWindow($target)
  if ([SessionNotifier.Native]::GetForegroundWindow() -eq $target) { break }

  # Second chance: a raw switch, then borrow the foreground thread's input state.
  [SessionNotifier.Native]::SwitchToThisWindow($target, $true)
  if ([SessionNotifier.Native]::GetForegroundWindow() -eq $target) { break }

  $owner = [SessionNotifier.Native]::GetForegroundWindow()
  $ownerThread = [SessionNotifier.Native]::GetWindowThreadProcessId($owner, [IntPtr]::Zero)
  $thisThread = [SessionNotifier.Native]::GetCurrentThreadId()
  $attached = [SessionNotifier.Native]::AttachThreadInput($thisThread, $ownerThread, $true)
  try {
    [void][SessionNotifier.Native]::BringWindowToTop($target)
    [void][SessionNotifier.Native]::SetForegroundWindow($target)
  } finally {
    if ($attached) { [void][SessionNotifier.Native]::AttachThreadInput($thisThread, $ownerThread, $false) }
  }
  Start-Sleep -Milliseconds 120
}

# Hold the front position across the shell's own post-click activation, then
# release the topmost flag. SWP_NOACTIVATE keeps this call from changing activation.
Start-Sleep -Milliseconds 150
[void][SessionNotifier.Native]::SetWindowPos($target, [IntPtr](-2), 0, 0, 0, 0, ($show -bor 0x0010))
Start-Sleep -Milliseconds 100

if ([SessionNotifier.Native]::GetForegroundWindow() -eq $target) { exit 0 }
exit 2
`
}

/** Encode a script for `powershell -EncodedCommand` (UTF-16LE base64). */
export function encodeCommand (script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Ask Windows to bring the shell window forward.
 *
 * Resolves once the PowerShell exits, so the log can carry what actually
 * happened; the HTTP response does not wait for it (the page must not block on
 * a half-second PowerShell start), hence the separate `start` / `await` halves.
 *
 * The child must NOT be spawned `detached`, and must not be `unref`ed without
 * keeping the exit handler alive: with `detached` on Windows, PowerShell starts
 * and exits in ~110ms with code 0 *without running the encoded command at all* —
 * measured here as 110ms vs 750ms for the same script without it. The symptom is
 * a "successful" raise that changes nothing. The Host process is long-lived, so
 * there is nothing to detach from anyway.
 * @returns a handle exposing the started child and its exit code, or `undefined`
 *   when the raise could not be started at all.
 */
export function startRaise () {
  if (process.platform !== 'win32') return undefined
  const pid = process.ppid
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodeCommand(raiseScript(pid)),
    ], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise((resolve) => {
      child.on('error', (error) => resolve({ error: error.message }))
      child.on('exit', (code) => resolve({ code }))
    })
    return { pid, exited }
  } catch (error) {
    recordRaise({ event: 'spawn-failed', hostPid: pid, error: String(error?.message ?? error) })
    return undefined
  }
}

/**
 * Fire the raise and record the outcome; never rejects.
 * @returns `true` when a raise was started.
 */
export function raiseWindow () {
  const attempt = startRaise()
  if (attempt === undefined) return false
  void attempt.exited.then((result) => {
    recordRaise({
      event: 'raise',
      hostPid: attempt.pid,
      ...result.error === undefined ? { exit: result.code } : { spawnError: result.error },
    })
  })
  return true
}

// ---------------------------------------------------------------- cross-device dismissal

/** How long a handled record stays replayable for a page that reconnects. */
export const HANDLED_TTL_MS = 60_000
/** Publish dedupe: every page reports the same handled Session, but one record is enough. */
export const HANDLED_DEDUPE_MS = 2_000
/** Cap on retained handled records; older entries are dropped first. */
export const HANDLED_HISTORY_LIMIT = 200
/** Heartbeat interval for an idle SSE stream (proxies drop silent connections). */
export const HANDLED_HEARTBEAT_MS = 25_000
/** Handled publish bodies are tiny JSON objects. */
export const HANDLED_BODY_LIMIT = 8 * 1024
/** How long a non-streaming `GET handled-events` waits for one record before 204. */
export const HANDLED_POLL_WAIT_MS = 10_000

/**
 * One process-wide "Session was handled" fan-out.
 *
 * The Host is the only component every page of one DSH instance shares, so the
 * hub lives here: a record published by one page reaches every other page's
 * subscription, and a page that reconnects replays what it missed from the
 * bounded history. History is bounded (TTL + count) so a long-running Host
 * cannot grow it without limit.
 * @returns the hub: publish, subscribe, and replay-after-id.
 */
export function createHandledHub () {
  /** Monotone record ids; a page sends the last one it saw back as Last-Event-ID. */
  let nextId = 1
  /** Oldest first. */
  const history = []
  const subscribers = new Set()
  /** Last published record per Session, so pages reporting the same answer do not multiply. */
  const lastBySession = new Map()

  const prune = (now) => {
    while (history.length > 0
      && (history.length > HANDLED_HISTORY_LIMIT || now - history[0].at > HANDLED_TTL_MS)) {
      history.shift()
    }
  }

  return {
    /**
     * Publish one handled record to every current subscriber.
     * @param sessionId - the Session that was handled elsewhere.
     * @param now - clock seam for tests.
     * @returns the stored record (id and timestamp included).
     */
    publish (sessionId, now = Date.now()) {
      prune(now)
      const last = lastBySession.get(sessionId)
      if (last !== undefined && now - last.at < HANDLED_DEDUPE_MS) return last
      const record = { id: String(nextId), sessionId, at: now }
      nextId += 1
      history.push(record)
      lastBySession.set(sessionId, record)
      for (const [key, value] of lastBySession) {
        if (now - value.at > HANDLED_TTL_MS) lastBySession.delete(key)
      }
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(record)
        } catch {
          /* one broken subscriber must not stop the others */
        }
      }
      return record
    },
    /**
     * Subscribe to records published from now on.
     * @param listener - called with each published record.
     * @returns the disposer removing the subscription.
     */
    subscribe (listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    /**
     * Records after a page's Last-Event-ID, oldest first.
     * @param lastEventId - the last id the page saw.
     * @returns the missed records.
     */
    since (lastEventId) {
      const after = Number(lastEventId)
      if (!Number.isFinite(after)) return []
      return history.filter((record) => Number(record.id) > after)
    },
    /** @returns how many records are currently replayable. */
    size: () => history.length,
  }
}

/** @returns the request body as UTF-8 text, or null when it exceeds `limit`. */
async function readBody (request, limit = HANDLED_BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.byteLength ?? chunk.length ?? 0
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
}

/**
 * Parse one handled publish body.
 * @param text - request body.
 * @returns `{ sessionId }`, or undefined when the shape is wrong.
 */
export function parseHandledBody (text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { sessionId } = value
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return { sessionId }
}

/**
 * Build the JSON body of one SSE `handled` frame.
 * @param record - the published record.
 * @returns the frame text (with id, event, and data lines).
 */
export function handledFrame (record) {
  return `id: ${record.id}\nevent: handled\ndata: ${JSON.stringify({ sessionId: record.sessionId })}\n\n`
}

/**
 * Build the POST handler that publishes one handled record.
 *
 * Kept separate from `apply` so the response contract is testable without a
 * server: untrusted 4xx first, POST only, JSON body, 204 accepted, 400 refused.
 * @param publish - publishes a session id and returns the record.
 * @param connection - the composition's trust fence.
 * @returns a node:http request handler.
 */
export function createHandledPublishHandler (publish, connection) {
  return async (request, response) => {
    const rejection = connection?.requestRejection?.(request)
    if (rejection !== undefined) {
      response.writeHead(rejection, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      response.end('POST only')
      return
    }
    const body = await readBody(request)
    const parsed = body === null ? undefined : parseHandledBody(body)
    if (parsed === undefined) {
      response.writeHead(400, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    publish(parsed.sessionId)
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
  }
}

/**
 * Build the SSE handler for handled records.
 *
 * The stream stays open for the life of the page: one heartbeat keeps proxies
 * from dropping it, and `request` close/abort unsubscribes and clears the
 * heartbeat. A plain `GET` without `Accept: text/event-stream` gets a bounded
 * JSON response instead of an open socket, which keeps the route usable from a
 * shell and makes the contract testable without a real stream.
 * @param hub - the process-wide hub.
 * @param connection - the composition's trust fence.
 * @param options - heartbeat and poll timing seams for tests.
 * @returns a node:http request handler.
 */
export function createHandledEventsHandler (hub, connection, options = {}) {
  const heartbeatMs = options.heartbeatMs ?? HANDLED_HEARTBEAT_MS
  const pollWaitMs = options.pollWaitMs ?? HANDLED_POLL_WAIT_MS
  return (request, response) => {
    const rejection = connection?.requestRejection?.(request)
    if (rejection !== undefined) {
      response.writeHead(rejection, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      response.end('GET only')
      return
    }
    const accept = String(request.headers?.accept ?? '')
    const lastEventId = request.headers?.['last-event-id']
    if (!accept.includes('text/event-stream')) {
      // A bounded long-poll: replay one missed record, otherwise wait briefly for
      // the next one, then 204. This is the page's transport (fetch works in both
      // the browser and the Desktop shell) and its test seam.
      const missed = lastEventId === undefined ? [] : hub.since(lastEventId)
      if (missed.length > 0) {
        const record = missed[0]
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ sessionId: record.sessionId, id: record.id }))
        return
      }
      let unsubscribe = () => {}
      const timer = setTimeout(() => {
        unsubscribe()
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      }, pollWaitMs)
      unsubscribe = hub.subscribe((record) => {
        clearTimeout(timer)
        unsubscribe()
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ sessionId: record.sessionId, id: record.id }))
      })
      request.on?.('close', () => {
        clearTimeout(timer)
        unsubscribe()
      })
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    for (const record of lastEventId === undefined ? [] : hub.since(lastEventId)) {
      response.write(handledFrame(record))
    }
    const unsubscribe = hub.subscribe((record) => {
      response.write(handledFrame(record))
    })
    const heartbeat = setInterval(() => {
      try {
        response.write(': heartbeat\n\n')
      } catch {
        /* the close handler disposes the subscription and the timer */
      }
    }, heartbeatMs)
    heartbeat.unref?.()
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    request.on?.('close', close)
    request.on?.('aborted', close)
    response.on?.('close', close)
  }
}

/**
 * Build the request handler that performs (or refuses) one window raise.
 *
 * Kept separate from `apply` so the response contract — untrusted 4xx first,
 * POST only, 204 accepted, 503 not started — is testable without spawning a
 * real PowerShell.
 * @param raise - function performing the raise; `true` when it was started.
 * @param connection - the composition's trust fence; `requestRejection(request)`
 *   returns an HTTP status to answer with, or `undefined` when the caller is
 *   trusted and authenticated.
 * @returns a node:http request handler.
 */
export function createRaiseHandler (raise, connection, record = recordRaise) {
  return (request, response) => {
    const rejection = connection?.requestRejection?.(request)
    record({
      event: 'request',
      method: request.method,
      gate: rejection === undefined ? 'trusted' : `rejected:${String(rejection)}`,
      hostPid: process.ppid,
    })
    if (rejection !== undefined) {
      response.writeHead(rejection, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      response.end('POST only')
      return
    }
    let raised = false
    try {
      raised = raise() === true
    } catch {
      raised = false
    }
    response.writeHead(raised ? 204 : 503, { 'cache-control': 'no-store' })
    response.end()
  }
}

/**
 * Install the Host routes for this profile: the handled-Session hub on every
 * platform (cross-device dismissal is not Windows-specific), and the
 * window-raise route only where Windows can raise a window.
 * @param ctx - Host plugin context.
 */
export function apply (ctx) {
  ctx.inject(['webServer', 'connection'], (scope) => {
    const hub = createHandledHub()
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: HANDLED_ROUTE,
      handler: createHandledPublishHandler((sessionId) => hub.publish(sessionId), scope.connection),
    }), 'session-notifier: handled publish route')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: HANDLED_EVENTS_ROUTE,
      handler: createHandledEventsHandler(hub, scope.connection),
    }), 'session-notifier: handled events stream')
    if (process.platform !== 'win32') return
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RAISE_ROUTE,
      handler: createRaiseHandler(raiseWindow, scope.connection),
    }), 'session-notifier: window raise route')
  })
}
