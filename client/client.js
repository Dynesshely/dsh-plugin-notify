/**
 * dsh-reminder — browser half.
 *
 * WHAT IT REMINDS YOU ABOUT
 *   - a question, a plan review or an approval is waiting for your answer in
 *     some session (ui-session's `SessionStatus.pendingInteraction`), and
 *   - a session's turn STOPPED (`SessionStatus.running` true → false), i.e. the
 *     agent finished. By default this reminds even while you are looking at
 *     that session; `setOnlyWhenAway(true)` narrows it to the Client's own
 *     "finished while unread" signal (`completionUnread`, which excludes the
 *     main view).
 *
 * DELIVERY
 *   1. a short Web Audio chime (a rising three-note "you are needed", a calmer
 *      falling two-note "done"), and
 *   2. a desktop notification when the browser has granted permission; tapping
 *      it focuses the window and opens that session.
 *
 * NOISE CONTROL
 *   - Facts present in the very first snapshot are adopted silently: they
 *     predate this page load, and replaying them would fire a burst of
 *     reminders on every reload/reconnect.
 *   - Completion reminders additionally wait for the session list to reach its
 *     `ready` phase, so a reconnect's baseline replay cannot ring.
 *   - A pending request is deduplicated by its request key: the same question
 *     reminds once, a replacement request reminds again.
 *   - A finished SUBAGENT session does not remind by default (one fan-out can
 *     finish dozens at once); `setSubagents(true)` includes them.
 *
 * MANUAL TEST / DIAGNOSIS (browser console)
 *   `__dshReminder.test('done')` — fire a "done" reminder now
 *   `__dshReminder.probe()`      — audio state, permission, counters
 */
window.__ModuleLoader__.load({
  id: 'dsh-reminder',
  factory(require) {
    /** Bundle identity: the module-loader registration id and the Cordis name agree. */
    const name = 'dsh-reminder'

    /** Client services: Session catalog (titles, subagent origin, phase), Session status, copy, settings slots. */
    const inject = ['sessions', 'uiSession', 'locale', 'slots']

    /** Platform modules: React, and the host's own button atom for the settings page. */
    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-reminder'

    /** Reminder copy, keyed by locale. */
    const DICT = {
      zh: {
        question: '需要你回答',
        planReview: '需要你确认计划',
        approval: '需要你批准',
        done: '会话已完成',
        doneBody: '这一轮已经结束，点开查看结果。',
        questionBody: '有一个问题在等你回答。',
        planReviewBody: '有一份计划在等你确认。',
        approvalBody: '有一个工具调用在等你批准。',
        testBody: '这是 dsh-reminder 的测试提醒。',
        tab: '提醒',
        settingsIntro: '会话需要你回答或批准、或者它的这一轮跑完时，这个插件会响一声并弹出系统通知。想先看效果就点下面的按钮。',
        testNeedsYou: '测试：需要你介入',
        testDone: '测试：会话已完成',
        statusPermission: '通知权限',
        statusAudio: '音频',
        statusIcon: '图标',
        statusFired: '已提醒',
        statusLast: '最近一次',
        statusNone: '还没有',
      },
      en: {
        question: 'Your answer is needed',
        planReview: 'Your plan review is needed',
        approval: 'Your approval is needed',
        done: 'Session finished',
        doneBody: 'That turn is done — open it to see the result.',
        questionBody: 'A question is waiting for your answer.',
        planReviewBody: 'A plan is waiting for your review.',
        approvalBody: 'A tool call is waiting for your approval.',
        testBody: 'This is a dsh-reminder test reminder.',
        tab: 'Reminders',
        settingsIntro: 'When a session needs your answer or approval, or finishes a turn, this plugin chimes and posts a desktop notification. Use the buttons below to see it now.',
        testNeedsYou: 'Test: you are needed',
        testDone: 'Test: session finished',
        statusPermission: 'permission',
        statusAudio: 'audio',
        statusIcon: 'icon',
        statusFired: 'fired',
        statusLast: 'last',
        statusNone: 'none yet',
      },
    }

    /** Chime notes per reminder kind, in hertz, with their offset in seconds. */
    const CHIME = {
      'needs-you': { type: 'triangle', notes: [[987.77, 0], [1318.51, 0.16], [987.77, 0.32]] },
      done: { type: 'sine', notes: [[659.25, 0], [493.88, 0.18]] },
    }

    let audioContext = null
    let askedPermission = false
    /** Icon resolution state: 'pending' until the page icon is ready, then 'ready' | 'unavailable' | 'none'. */
    let iconState = 'pending'
    /** The resolved icon URL handed to every notification. */
    let iconUrl

    /**
     * The page's own icon as a URL the Notification API can render. Web
     * notifications do not draw SVG and the shell declares an SVG favicon
     * (`<link rel="icon" href="/favicon.svg">`), so that file is fetched and
     * rasterized through a canvas once per page; a bitmap icon link is used
     * as-is, and a failed rasterization falls back to the raw href.
     * @returns the icon URL, or undefined when the page declares no icon.
     */
    async function resolveNotificationIcon() {
      const link = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]')
      const href = link?.href
      if (href === undefined) return undefined
      const isSvg = /\.svg(\?|#|$)/i.test(href) || String(link.getAttribute?.('type') ?? '').includes('svg')
      if (!isSvg) return href
      let objectUrl
      try {
        const response = await fetch(href, { credentials: 'same-origin' })
        if (response.ok === false) return href
        objectUrl = URL.createObjectURL(await response.blob())
        const image = new Image()
        image.src = objectUrl
        await (typeof image.decode === 'function'
          ? image.decode()
          : new Promise((resolve, reject) => {
            image.onload = resolve
            image.onerror = reject
          }))
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 128
        const context = canvas.getContext('2d')
        if (context === null) return href
        context.drawImage(image, 0, 0, 128, 128)
        return canvas.toDataURL('image/png')
      } catch {
        return href
      } finally {
        if (objectUrl !== undefined) {
          try {
            URL.revokeObjectURL(objectUrl)
          } catch {
            /* a browser without object URLs needs no cleanup */
          }
        }
      }
    }

    /**
     * Lazily create the page's audio context.
     * @returns the context, or null when the browser has no Web Audio.
     */
    function audio() {
      if (audioContext !== null) return audioContext
      const Ctor = window.AudioContext ?? window.webkitAudioContext
      if (Ctor === undefined) return null
      try {
        audioContext = new Ctor()
      } catch {
        audioContext = null
      }
      return audioContext
    }

    /**
     * Play one reminder chime. A page that has not yet seen a user gesture has
     * its context suspended, so the sound is simply skipped there.
     * @param kind - 'needs-you' or 'done'.
     * @returns whether the chime was handed to the audio hardware.
     */
    function chime(kind) {
      const context = audio()
      if (context === null) return false
      if (context.state === 'suspended') void context.resume().catch(() => {})
      const shape = CHIME[kind]
      const origin = context.currentTime
      for (const [frequency, offset] of shape.notes) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = shape.type
        oscillator.frequency.value = frequency
        const start = origin + offset
        const end = start + 0.22
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, end)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(start)
        oscillator.stop(end + 0.02)
      }
      return true
    }

    /**
     * Build the `t` bound to this plugin's namespace, falling back to the
     * Chinese copy when the locale service is unavailable.
     * @param ctx - client context.
     * @returns the translator.
     */
    function translator(ctx) {
      let bound = null
      try {
        bound = ctx.locale.bind(NS)
      } catch {
        bound = null
      }
      return (key) => {
        if (bound !== null) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== key) return value
          } catch {
            /* fall through to the built-in copy */
          }
        }
        return DICT.zh[key] ?? key
      }
    }

    /**
     * One session's catalog row, or undefined.
     * @param ctx - client context.
     * @param sessionId - session identity.
     * @returns the row, or undefined when unknown.
     */
    function sessionRow(ctx, sessionId) {
      if (sessionId === undefined) return undefined
      try {
        return ctx.sessions.list.getSnapshot().byId[sessionId]
      } catch {
        return undefined
      }
    }

    /**
     * Whether the Session list has finished its baseline, i.e. whether a stop
     * observed now is real rather than a replay artifact.
     * @param ctx - client context.
     * @returns whether the list is ready.
     */
    function listReady(ctx) {
      try {
        return ctx.sessions.list.getSnapshot().phase === 'ready'
      } catch {
        return true
      }
    }

    /**
     * Human label for one session, from the Client catalog.
     * @param ctx - client context.
     * @param sessionId - session identity, or undefined for a session-less test.
     * @returns the label, or '' when unknown.
     */
    function sessionLabel(ctx, sessionId) {
      const row = sessionRow(ctx, sessionId)
      return row?.displayTitle ?? row?.title ?? ''
    }

    /**
     * Whether one session's completion is worth a reminder: top-level sessions
     * always, subagent sessions only when explicitly enabled.
     * @param ctx - client context.
     * @param sessionId - session identity.
     * @param includeSubagents - the live option.
     * @returns whether to remind.
     */
    function completionCounts(ctx, sessionId, includeSubagents) {
      if (includeSubagents) return true
      return sessionRow(ctx, sessionId)?.origin !== 'subagent'
    }

    /**
     * Focus the session a reminder points at, when the workspace service can.
     * @param ctx - client context.
     * @param sessionId - session to open, or undefined for a test reminder.
     */
    function openSession(ctx, sessionId) {
      if (sessionId === undefined) return
      try {
        ctx.get?.('uiWorkspace')?.openSession?.(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-reminder: openSession failed: ${String(error)}`)
      }
    }

    /**
     * Deliver one reminder through every enabled channel.
     * @param ctx - client context.
     * @param state - live options and counters.
     * @param t - bound translator.
     * @param kind - 'needs-you' or 'done'.
     * @param sessionId - the session it belongs to, when known.
     * @param interaction - the pending interaction that raised it, when any.
     */
    function remind(ctx, state, t, kind, sessionId, interaction) {
      if (!state.enabled) return
      const label = sessionLabel(ctx, sessionId)
      const domain = kind === 'needs-you' ? (interaction?.kind ?? 'question') : null
      let headline
      let body
      if (kind === 'done') {
        headline = `✅ ${t('done')}`
        body = t('doneBody')
      } else if (domain === 'approval') {
        headline = `🔐 ${t('approval')}`
        body = interaction?.reason ?? interaction?.toolName ?? t('approvalBody')
      } else if (domain === 'plan-review') {
        headline = `📋 ${t('planReview')}`
        body = interaction?.questions?.[0]?.question ?? t('planReviewBody')
      } else {
        headline = `❓ ${t('question')}`
        body = interaction?.questions?.[0]?.question ?? t('questionBody')
      }
      const title = label === '' ? headline : `${headline} · ${label}`
      // The manual console hook carries no session and no request: it says so
      // rather than imitating a real question.
      const manual = kind === 'done' ? sessionId === undefined : sessionId === undefined && interaction === undefined
      if (manual) body = t('testBody')
      if (state.sound) chime(kind)
      if (state.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const options = {
            body,
            tag: `dsh-reminder:${String(sessionId ?? 'test')}:${kind}`,
            silent: true,
          }
          // The page's own icon while it is available; the browser falls back
          // to its default when it is not.
          if (iconUrl !== undefined) options.icon = iconUrl
          const notification = new Notification(title, options)
          notification.onclick = () => {
            window.focus()
            openSession(ctx, sessionId)
            notification.close()
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-reminder: notification failed: ${String(error)}`)
        }
      }
      state.fired += 1
      state.last = { kind, sessionId: sessionId ?? null, title, body, at: Date.now() }
    }

    /**
     * Mount the reminder engine.
     * @param ctx - client context; `ctx.effect` owns every listener for the
     *              life of this fiber (HMR reload, bundle removal).
     */
    function apply(ctx) {
      if (typeof document === 'undefined') return
      const t = translator(ctx)
      const state = {
        enabled: true,
        sound: true,
        desktop: true,
        subagents: false,
        /** Restrict completion reminders to the Client's "finished while unread" signal. */
        onlyWhenAway: false,
        /** sessionId → { pending, running, unread } last adopted. */
        seen: new Map(),
        /** False until the first snapshot has been adopted without reminding. */
        primed: false,
        fired: 0,
        last: null,
      }

      ctx.effect(() => {
        const dispose = ctx.locale?.register?.(NS, DICT)
        return typeof dispose === 'function' ? dispose : undefined
      }, 'dsh-reminder: dictionaries')

      // Resolve the page icon once (the shell's favicon is an SVG, which
      // notifications cannot draw). Runs at activation so it is ready long
      // before the first reminder; `probe().icon` reports the outcome.
      void resolveNotificationIcon().then((value) => {
        iconUrl = value
        iconState = value === undefined ? 'none' : 'ready'
      }, () => {
        iconState = 'unavailable'
      })

      // One gesture is what unlocks the audio context (and, once, asks for
      // notification permission). Both listeners stay: a context can suspend
      // again after the tab is backgrounded.
      const unlock = () => {
        const context = audio()
        if (context !== null && context.state === 'suspended') void context.resume().catch(() => {})
        if (askedPermission) return
        askedPermission = true
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            void Notification.requestPermission().catch(() => {})
          }
        } catch {
          /* unsupported notification permission request: the chime still works */
        }
      }
      ctx.effect(() => {
        document.addEventListener('pointerdown', unlock, true)
        document.addEventListener('keydown', unlock, true)
        return () => {
          document.removeEventListener('pointerdown', unlock, true)
          document.removeEventListener('keydown', unlock, true)
        }
      }, 'dsh-reminder: audio unlock and permission ask')

      /**
       * Diff one Session status snapshot into reminders.
       * @param snapshot - the current SessionStatusSnapshot.
       */
      const onStatus = (snapshot) => {
        const ready = listReady(ctx)
        const next = new Map()
        for (const [sessionId, status] of snapshot) {
          const previous = state.seen.get(sessionId)
          const pending = status.pendingInteraction
          const pendingKey = pending === undefined ? null : pending.key
          const running = status.running
          const unread = status.completionUnread === true
          next.set(sessionId, { pending: pendingKey, running, unread })
          if (!state.primed) continue
          // 1. A newly arrived request (question / plan review / approval).
          //    It outranks a completion: the session is not done, it waits.
          if (pendingKey !== null && pendingKey !== previous?.pending) {
            remind(ctx, state, t, 'needs-you', sessionId, pending)
            continue
          }
          // 2. This turn stopped — either we watched running go true → false,
          //    or the Client reported the unread-completion fact (a stop the
          //    first signal could have missed). Never both for one stop.
          //    `becameUnread` requires a session we already tracked: a row that
          //    first appears already-unread is pre-existing state (a reconnect
          //    replay), not a stop we witnessed.
          const stopped = previous?.running === true && running === false
          const becameUnread = unread && previous !== undefined && previous.unread !== true
          const completion = state.onlyWhenAway ? becameUnread : (stopped || becameUnread)
          if (!completion) continue
          // A reconnect's baseline replay must not ring.
          if (!ready) continue
          if (!completionCounts(ctx, sessionId, state.subagents)) continue
          remind(ctx, state, t, 'done', sessionId, undefined)
        }
        state.seen = next
        state.primed = true
      }

      ctx.effect(() => ctx.uiSession.sessionStatus.subscribe(() => {
        onStatus(ctx.uiSession.sessionStatus.getSnapshot())
      }), 'dsh-reminder: session status subscription')

      /** Service face and console hook: read the options, drive a manual test. */
      const api = {
        /** Whether any reminder is delivered. */
        isEnabled: () => state.enabled,
        /** Toggle the whole engine. */
        setEnabled: (value) => { state.enabled = value !== false },
        /** Whether the chime plays. */
        isSoundEnabled: () => state.sound,
        /** Toggle the chime. */
        setSound: (value) => { state.sound = value !== false },
        /** Whether desktop notifications are attempted. */
        isDesktopEnabled: () => state.desktop,
        /** Toggle desktop notifications. */
        setDesktop: (value) => { state.desktop = value !== false },
        /** Whether finished subagent sessions also remind. */
        areSubagentsEnabled: () => state.subagents,
        /** Toggle reminders for finished subagent sessions. */
        setSubagents: (value) => { state.subagents = value === true },
        /** Whether completions only remind when the session is not the main view. */
        isOnlyWhenAway: () => state.onlyWhenAway,
        /** Toggle that restriction. */
        setOnlyWhenAway: (value) => { state.onlyWhenAway = value === true },
        /** The browser's notification permission right now. */
        notificationPermission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
        /** Ask for notification permission (needs a user gesture in Safari). */
        requestPermission: () => (typeof Notification === 'undefined' ? Promise.resolve('unsupported') : Notification.requestPermission()),
        /** Fire one reminder now: 'needs-you' (default) or 'done'. */
        test: (kind) => { remind(ctx, state, t, kind === 'done' ? 'done' : 'needs-you', undefined, undefined) },
        /** Everything needed to explain a silent reminder. */
        probe: () => ({
          loaded: true,
          enabled: state.enabled,
          sound: state.sound,
          desktop: state.desktop,
          subagents: state.subagents,
          onlyWhenAway: state.onlyWhenAway,
          primed: state.primed,
          trackedSessions: state.seen.size,
          fired: state.fired,
          last: state.last,
          audio: audioContext === null ? 'not-created-yet' : audioContext.state,
          audioSupported: (window.AudioContext ?? window.webkitAudioContext) !== undefined,
          icon: iconState,
          iconUrl: iconUrl === undefined ? null : `${String(iconUrl).slice(0, 32)}…`,
          permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
          visibility: document.visibilityState,
          focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        }),
        /** What this engine is doing, for diagnostics. */
        describe: () => ({
          enabled: state.enabled,
          sound: state.sound,
          desktop: state.desktop,
          subagents: state.subagents,
          onlyWhenAway: state.onlyWhenAway,
          fired: state.fired,
          last: state.last,
        }),
      }
      ctx.effect(() => {
        window.__dshReminder = api
        try {
          ctx.reflect.provide('reminder', api)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-reminder: service face unavailable: ${String(error)}`)
        }
        return () => {
          if (window.__dshReminder === api) delete window.__dshReminder
        }
      }, 'dsh-reminder: service face and console hook')

      /**
       * One status line: the same facts `probe()` reports, so a silent reminder
       * can be explained from the settings page without the console.
       * @param translate - the tab's bound translator.
       * @param facts - a probe() snapshot.
       * @returns the rendered line.
       */
      const statusLine = (translate, facts) => [
        `${translate('statusPermission')} ${facts.permission}`,
        `${translate('statusAudio')} ${facts.audio}`,
        `${translate('statusIcon')} ${facts.icon}`,
        `${translate('statusFired')} ${String(facts.fired)}`,
        `${translate('statusLast')} ${facts.last === null
          ? translate('statusNone')
          : (facts.last.kind === 'done' ? translate('done') : translate('question'))}`,
      ].join(' · ')

      /**
       * Settings → Plugins → dsh-reminder: one click to see and hear what a
       * reminder looks like, plus the live facts behind a silent one.
       * @param props - slot props; `t` is bound to this plugin's namespace.
       * @returns the tab content.
       */
      function ReminderSettingsTab(props) {
        const translate = typeof props?.t === 'function' ? props.t : t
        const [facts, setFacts] = React.useState(() => api.probe())
        const fire = (kind) => () => {
          api.test(kind)
          setFacts(api.probe())
        }
        return React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        },
        React.createElement('p', {
          style: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
        }, translate('settingsIntro')),
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          React.createElement(Button, { variant: 'primary', size: 'sm', onClick: fire('needs-you') }, translate('testNeedsYou')),
          React.createElement(Button, { variant: 'outline', size: 'sm', onClick: fire('done') }, translate('testDone')),
        ),
        React.createElement('p', {
          style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
        }, statusLine(translate, facts)))
      }

      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'dsh-reminder',
        order: 50,
        label: () => t('tab'),
        locale: NS,
      }, ReminderSettingsTab)), 'dsh-reminder: settings page')

      // The same page also gets its own row in the Settings nav: a tab inside
      // the Plugins section is easy to miss, and "Settings → Reminders" is the
      // one path a user looks for first.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-reminder',
        order: 90,
        label: () => t('tab'),
        locale: NS,
      }, ReminderSettingsTab)), 'dsh-reminder: settings nav row')
    }

    return { name, inject, apply }
  },
})
