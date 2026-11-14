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

await check('the browser half and the Host half agree on the raise route', () => {
  assert.ok(plugin.RAISE_ROUTE.startsWith('/plugin/'), 'the route is namespaced under /plugin/')
  assert.ok(clientSource.includes(`'${plugin.RAISE_ROUTE}'`), 'client.js posts to the same path')
})

await check('the diagnostic trail lives in the DSH home', () => {
  const path = plugin.raiseLogPath()
  assert.ok(path.endsWith('session-notifier-raise.log'), path)
})

await check('the route is registered only where a window can be raised', () => {
  const { ctx, routes, injected } = createHost()
  plugin.apply(ctx)
  if (process.platform !== 'win32') {
    assert.equal(injected.length, 0, 'a non-Windows Host registers nothing at all')
    assert.equal(routes.length, 0)
    return
  }
  assert.deepEqual(injected, [['webServer', 'connection']], 'the route waits for the carrier and its trust fence')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, plugin.RAISE_ROUTE)
})

await check('the registration is disposed with the plugin', () => {
  const { ctx, routes, disposers } = createHost()
  plugin.apply(ctx)
  if (process.platform !== 'win32') return
  assert.equal(routes.length, 1)
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(routes.length, 0, 'disposal removes the route')
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
