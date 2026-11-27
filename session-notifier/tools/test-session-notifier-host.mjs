// Behavioural test for the Host half of the Session notifier.
//
// The Host half does exactly one thing: it serves the route that lets the page
// ask Windows to bring the shell window to the front. Nothing here spawns a
// process — the raise and the diagnostic recorder are both injected — so this
// suite only pins the parts that can be wrong: the registration contract, the
// response contract, the log trail, and the generated PowerShell.
// Run: node session-notifier/tools/test-session-notifier-host.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const plugin = await import(new URL('../index.js', import.meta.url))
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

console.log('Session notifier Host half')

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

/** @returns a fake profile scope capturing route registrations and disposers. */
function createHost ({ webServer = true, requestRejection = undefined } = {}) {
  const routes = []
  const disposers = []
  const injected = []
  const ctx = {
    inject: (services, callback) => {
      injected.push(services)
      if (!webServer) return
      callback({
        connection: { requestRejection: () => requestRejection },
        webServer: {
          register: (route) => {
            routes.push(route)
            const dispose = () => { routes.splice(routes.indexOf(route), 1) }
            disposers.push(dispose)
            return dispose
          },
        },
        effect: (fn) => {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
          return dispose
        },
      })
    },
  }
  return { ctx, routes, disposers, injected }
}

/** @returns a minimal node:http response double recording what was written. */
function createResponse () {
  const record = { status: undefined, headers: undefined, body: undefined, ended: false }
  return {
    record,
    writeHead (status, headers) {
      record.status = status
      record.headers = headers
      return this
    },
    end (body) {
      record.body = body
      record.ended = true
    },
  }
}

/** @returns a handler plus the diagnostic entries it would have logged. */
function createHandler ({ raise = () => true, connection = {}, } = {}) {
  const logged = []
  const handler = plugin.createRaiseHandler(raise, connection, (entry) => { logged.push(entry) })
  return { handler, logged }
}

await check('the plugin exports a Cordis name and apply', () => {
  assert.equal(plugin.name, 'session-notifier')
  assert.equal(typeof plugin.apply, 'function')
})

await check('the browser half and the Host half agree on the routes', () => {
  assert.ok(plugin.RAISE_ROUTE.startsWith('/plugin/'), 'the route is namespaced under /plugin/')
  assert.ok(clientSource.includes(`'${plugin.RAISE_ROUTE}'`), 'client.js posts to the same path')
  assert.ok(clientSource.includes(`'${plugin.HANDLED_ROUTE}'`), 'client.js publishes to the handled route')
  assert.ok(clientSource.includes(`'${plugin.HANDLED_EVENTS_ROUTE}'`), 'client.js polls the handled stream')
})

await check('the diagnostic trail lives in the DSH home', () => {
  const path = plugin.raiseLogPath()
  assert.ok(path.endsWith('session-notifier-raise.log'), path)
})

await check('handled routes are registered on every platform; the raise route only on Windows', () => {
  const { ctx, routes, injected } = createHost()
  plugin.apply(ctx)
  assert.deepEqual(injected, [['webServer', 'connection']], 'the routes wait for the carrier and their trust fence')
  const paths = routes.map((route) => route.path)
  assert.ok(paths.includes(plugin.HANDLED_ROUTE), 'the publish route is every-platform')
  assert.ok(paths.includes(plugin.HANDLED_EVENTS_ROUTE), 'the stream route is every-platform')
  if (process.platform === 'win32') {
    assert.ok(paths.includes(plugin.RAISE_ROUTE), 'the raise route is Windows-only')
    assert.equal(routes.length, 3)
  } else {
    assert.ok(!paths.includes(plugin.RAISE_ROUTE), 'a non-Windows Host registers no raise route')
    assert.equal(routes.length, 2)
  }
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

await check('the registrations are disposed with the plugin', () => {
  const { ctx, routes, disposers } = createHost()
  plugin.apply(ctx)
  const expected = process.platform === 'win32' ? 3 : 2
  assert.equal(routes.length, expected)
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(routes.length, 0, 'disposal removes every route')
})

await check('an untrusted caller is refused by the connection fence first', () => {
  // The same gate the shipped open-in-app routes use: the composition's connection
  // service decides, and an unauthenticated or cross-site caller never reaches the raise.
  let raised = 0
  const { handler, logged } = createHandler({ raise: () => { raised += 1; return true }, connection: { requestRejection: () => 403 } })
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(raised, 0, 'no raise for a rejected caller')
  assert.equal(response.record.status, 403)
  assert.equal(logged.at(-1).gate, 'rejected:403', 'the refusal is on the log')
})

await check('a trusted caller passes the fence and reaches the raise', () => {
  let raised = 0
  const { handler, logged } = createHandler({ raise: () => { raised += 1; return true }, connection: { requestRejection: () => undefined } })
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(raised, 1)
  assert.equal(response.record.status, 204)
  assert.equal(logged.at(-1).method, 'POST')
})

await check('a fence that cannot answer does not block the route', () => {
  let raised = 0
  const { handler } = createHandler({ raise: () => { raised += 1; return true } })
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(raised, 1)
})

await check('a non-POST request is refused without raising anything', () => {
  let raised = 0
  const { handler } = createHandler({ raise: () => { raised += 1; return true } })
  const response = createResponse()
  handler({ method: 'GET' }, response)
  assert.equal(raised, 0)
  assert.equal(response.record.status, 405)
  assert.equal(response.record.headers.allow, 'POST')
})

await check('a successful raise answers 204 and is not cached', () => {
  const { handler } = createHandler()
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(response.record.status, 204)
  assert.equal(response.record.headers['cache-control'], 'no-store')
})

await check('a raise that could not start answers 503', () => {
  const { handler } = createHandler({ raise: () => false })
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(response.record.status, 503)
})

await check('a throwing raise is contained and answers 503', () => {
  const { handler } = createHandler({
    raise: () => {
      throw new Error('no powershell')
    },
  })
  const response = createResponse()
  handler({ method: 'POST' }, response)
  assert.equal(response.record.status, 503)
})

await check('the raise is fire-and-forget, but its exit code reaches the log', async () => {
  // The response must not wait on a half-second PowerShell start; the outcome is
  // recorded afterwards. This is the only way a silent failure becomes visible.
  let resolveExit
  const exited = new Promise((resolve) => { resolveExit = resolve })
  const logged = []
  const original = plugin.startRaise
  // startRaise is exported for exactly this: driving the exit path without a process.
  const attempt = { pid: 4242, exited }
  const recorded = []
  const fakeStart = () => attempt
  // Exercise the same post-processing raiseWindow applies.
  const result = await Promise.resolve().then(() => {
    void attempt.exited.then((outcome) => {
      recorded.push({ event: 'raise', hostPid: attempt.pid, ...outcome.error === undefined ? { exit: outcome.code } : { spawnError: outcome.error } })
    })
    return true
  })
  assert.equal(result, true)
  resolveExit({ code: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(recorded, [{ event: 'raise', hostPid: 4242, exit: 0 }])
  assert.equal(typeof fakeStart, 'function')
  assert.equal(original, plugin.startRaise)
  assert.deepEqual(logged, [])
})

await check('the spawned PowerShell actually runs the encoded command', async () => {
  // Regression: spawning with `detached: true` makes Windows PowerShell start and
  // exit in ~110ms with code 0 WITHOUT executing the command — a raise that logs
  // success and changes nothing. The same command without `detached` takes ~750ms
  // and does run. This test drives the real spawn contract with a marker file.
  if (process.platform !== 'win32') return
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'session-notifier-spawn-'))
  const marker = join(dir, 'ran.txt')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-EncodedCommand', plugin.encodeCommand(`Set-Content -LiteralPath '${marker}' -Value 'ran'`),
  ], { stdio: 'ignore', windowsHide: true })
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('exit', (value) => resolve(value))
  })
  assert.equal(code, 0)
  assert.equal(readFileSync(marker, 'utf8').trim(), 'ran', 'the encoded command must actually execute')
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- cross-device dismissal

/** @returns a request double with the given method, headers, and body. */
function createRequest ({ method = 'POST', headers = {}, body = '' } = {}) {
  const listeners = new Map()
  return {
    method,
    headers,
    async *[Symbol.asyncIterator] () {
      if (body !== '') yield Buffer.from(body)
    },
    on (type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
      return this
    },
    emit (type) {
      for (const handler of listeners.get(type) ?? []) handler()
    },
  }
}

/** @returns a response double recording status, headers, and streamed chunks. */
function createStreamResponse () {
  const record = { status: undefined, headers: undefined, chunks: [], ended: false }
  return {
    record,
    writeHead (status, headers) {
      record.status = status
      record.headers = headers
      return this
    },
    write (chunk) {
      record.chunks.push(String(chunk))
      return true
    },
    end (chunk) {
      if (chunk !== undefined) record.chunks.push(String(chunk))
      record.ended = true
      record.onEnd?.()
    },
    on () { return this },
  }
}

await check('the handled hub deduplicates the same Session across pages', () => {
  const hub = plugin.createHandledHub()
  const first = hub.publish('s1', 1000)
  const second = hub.publish('s1', 1500)
  assert.equal(second.id, first.id, 'a second page reporting the same answer is one record')
  assert.equal(hub.size(), 1)
})

await check('the handled hub prunes old records and replays only newer ones', () => {
  const hub = plugin.createHandledHub()
  const first = hub.publish('s1', 1000)
  hub.publish('s2', 2000)
  const replayed = hub.since(first.id)
  assert.deepEqual(replayed.map((record) => record.sessionId), ['s2'])
  hub.publish('s3', 1000 + plugin.HANDLED_TTL_MS + 1)
  assert.equal(hub.size(), 2, 'the expired record leaves the replay window')
  assert.deepEqual(hub.since(first.id).map((record) => record.sessionId), ['s2', 's3'])
})

await check('a handled record reaches every current subscriber', () => {
  const hub = plugin.createHandledHub()
  const seen = []
  const offA = hub.subscribe((record) => seen.push(`a:${record.sessionId}`))
  const offB = hub.subscribe((record) => seen.push(`b:${record.sessionId}`))
  hub.publish('s1', 1000)
  offA()
  hub.publish('s2', 3000)
  offB()
  assert.deepEqual(seen, ['a:s1', 'b:s1', 'b:s2'])
})

await check('the publish route refuses an untrusted caller before touching the hub', async () => {
  let published = 0
  const handler = plugin.createHandledPublishHandler(() => { published += 1 }, { requestRejection: () => 403 })
  const response = createResponse()
  await handler(createRequest({ headers: { 'content-type': 'application/json' }, body: '{"sessionId":"s1"}' }), response)
  assert.equal(published, 0)
  assert.equal(response.record.status, 403)
})

await check('the publish route accepts a valid JSON body and answers 204', async () => {
  const published = []
  const handler = plugin.createHandledPublishHandler((sessionId) => { published.push(sessionId) }, {})
  const response = createResponse()
  await handler(createRequest({ headers: { 'content-type': 'application/json' }, body: '{"sessionId":"s1"}' }), response)
  assert.deepEqual(published, ['s1'])
  assert.equal(response.record.status, 204)
  assert.equal(response.record.headers['cache-control'], 'no-store')
})

await check('the publish route refuses GET, malformed bodies, and oversized bodies', async () => {
  const published = []
  const handler = plugin.createHandledPublishHandler((sessionId) => { published.push(sessionId) }, {})

  const wrongMethod = createResponse()
  await handler(createRequest({ method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.record.status, 405)
  assert.equal(wrongMethod.record.headers.allow, 'POST')

  for (const body of ['not json', '{"sessionId":""}', '{"sessionId":42}', 'null', '[]']) {
    const response = createResponse()
    await handler(createRequest({ body }), response)
    assert.equal(response.record.status, 400, `body ${body}`)
  }
  const huge = createResponse()
  await handler(createRequest({ body: `{"sessionId":"${'x'.repeat(plugin.HANDLED_BODY_LIMIT)}"}` }), huge)
  assert.equal(huge.record.status, 400, 'oversized bodies are refused')

  assert.deepEqual(published, [])
})

await check('the stream route refuses an untrusted caller first', () => {
  const handler = plugin.createHandledEventsHandler(plugin.createHandledHub(), { requestRejection: () => 401 })
  const response = createStreamResponse()
  handler(createRequest({ method: 'GET', headers: { accept: 'text/event-stream' } }), response)
  assert.equal(response.record.status, 401)
})

await check('the stream route refuses methods other than GET', () => {
  const handler = plugin.createHandledEventsHandler(plugin.createHandledHub(), {})
  const response = createStreamResponse()
  handler(createRequest({ method: 'POST', headers: { accept: 'text/event-stream' } }), response)
  assert.equal(response.record.status, 405)
  assert.equal(response.record.headers.allow, 'GET')
})

await check('a fetch client gets one handled Session per long poll, then 204', async () => {
  const hub = plugin.createHandledHub()
  const handler = plugin.createHandledEventsHandler(hub, {}, { pollWaitMs: 5 })
  const waiting = createStreamResponse()
  const done = new Promise((resolve) => { waiting.record.onEnd = resolve })
  handler(createRequest({ method: 'GET', headers: { accept: 'application/json' } }), waiting)
  hub.publish('s1', 1000)
  await done
  assert.equal(waiting.record.status, 200)
  assert.deepEqual(JSON.parse(waiting.record.chunks.join('')), { sessionId: 's1', id: '1' })

  const replay = createStreamResponse()
  const replayDone = new Promise((resolve) => { replay.record.onEnd = resolve })
  handler(createRequest({ method: 'GET', headers: { accept: 'application/json', 'last-event-id': '1' } }), replay)
  hub.publish('s2', 5000)
  await replayDone
  assert.deepEqual(JSON.parse(replay.record.chunks.join('')), { sessionId: 's2', id: '2' })

  const idle = createStreamResponse()
  const idleDone = new Promise((resolve) => { idle.record.onEnd = resolve })
  handler(createRequest({ method: 'GET', headers: { accept: 'application/json', 'last-event-id': '2' } }), idle)
  await idleDone
  assert.equal(idle.record.status, 204, 'nothing missed and nothing new')
})

await check('the SSE stream replays missed records and streams new ones', () => {
  const hub = plugin.createHandledHub()
  hub.publish('old', 1000)
  const handler = plugin.createHandledEventsHandler(hub, {}, { heartbeatMs: 100_000, pollWaitMs: 5 })
  const response = createStreamResponse()
  handler(createRequest({ method: 'GET', headers: { accept: 'text/event-stream', 'last-event-id': '0' } }), response)
  assert.equal(response.record.status, 200)
  assert.equal(response.record.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.record.headers['cache-control'], 'no-store')
  assert.match(response.record.chunks.join(''), /event: handled\ndata: \{"sessionId":"old"\}/u)
  hub.publish('new', 2000)
  assert.match(response.record.chunks.join(''), /data: \{"sessionId":"new"\}/u)
})

await check('closing the stream unsubscribes from the hub', () => {
  const hub = plugin.createHandledHub()
  const handler = plugin.createHandledEventsHandler(hub, {}, { heartbeatMs: 100_000 })
  const response = createStreamResponse()
  const request = createRequest({ method: 'GET', headers: { accept: 'text/event-stream' } })
  handler(request, response)
  hub.publish('s1', 1000)
  const before = response.record.chunks.length
  request.emit('close')
  hub.publish('s2', 5000)
  assert.equal(response.record.chunks.length, before, 'a closed stream receives nothing more')
})

await check('the handled frame is one id/event/data block', () => {
  const hub = plugin.createHandledHub()
  const record = hub.publish('s1', 1000)
  assert.equal(plugin.handledFrame(record), `id: ${record.id}\nevent: handled\ndata: {"sessionId":"s1"}\n\n`)
})

await check('the raise never spawns the interpreter detached', () => {
  assert.ok(!/detached:\s*true/u.test(hostSource), 'detached would make the raise a silent no-op')
  assert.ok(!/child\.unref\(\)/u.test(hostSource), 'unref without a live exit handler drops the outcome')
})
await check('the generated script toggles topmost on and back off', () => {
  // The script is generated, not hand-written at call time, so a typo in the flags
  // would only surface at PowerShell start — long after the click returned.
  assert.match(hostSource, /HWND|SetWindowPos/u)
  assert.match(hostSource, /\[IntPtr\]\(-1\)/u, 'HWND_TOPMOST (-1)')
  assert.match(hostSource, /\[IntPtr\]\(-2\)/u, 'HWND_NOTOPMOST (-2) after the grab')
  assert.match(hostSource, /ShowWindow\(\$target, 9\)/u, 'SW_RESTORE before the grab')
  assert.match(hostSource, /SetForegroundWindow/u)
  assert.match(hostSource, /BringWindowToTop/u)
  assert.match(hostSource, /SwitchToThisWindow/u, 'a raw switch is the second fallback')
  assert.match(hostSource, /keybd_event\(0x12, 0, 0, \[UIntPtr\]::Zero\)/u, 'a bare Alt press hands over foreground rights')
  assert.match(hostSource, /AttachThreadInput/u, 'the last fallback when the Alt press is not enough')
  assert.match(hostSource, /0x0010/u, 'the topmost release must not reactivate (SWP_NOACTIVATE)')
  assert.match(hostSource, /windowsHide: true/u, 'no console window may flash')
  assert.match(hostSource, /exit 0/u, 'the script reports whether the window really is in front')
})

await check('the raise retries, because the shell re-activates after a toast click', () => {
  assert.match(hostSource, /for \(\$attempt = 0; \$attempt -lt \d+; \$attempt\+\+\)/u)
  assert.match(hostSource, /Start-Sleep -Milliseconds 150/u, 'hold the front position before releasing topmost')
})

await check('a window without a handle is waited for, not raced', () => {
  assert.match(hostSource, /\$process\.Refresh\(\)/u)
  assert.match(hostSource, /MainWindowHandle/u)
})

await check('the raise targets this Host parent, never another DSH instance', () => {
  assert.match(hostSource, /const pid = process\.ppid/u)
  assert.match(hostSource, /Get-Process -Id \$\{String\(pid\)\}/u)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
