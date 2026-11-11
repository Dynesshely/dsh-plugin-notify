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
 * CHILD SESSIONS
 *   A subagent (including Agent Teams teammates) is a Session with
 *   `origin === 'subagent'` or a `parentId`; those remind nothing by default so
 *   one fan-out does not ring dozens of times. `setSubagents(true)` includes
 *   them again.
 *
 * DELIVERY
 *   1. a short Web Audio chime (a rising three-note "you are needed", a calmer
 *      falling two-note "done"), and
 *   2. a desktop notification when the browser has granted permission; tapping
 *      it focuses the window and opens that session.
 *   The notification icon is the page's own icon rasterized through a canvas
 *   with rounded corners; the shell's favicon is an SVG and its touch icon is a
 *   bitmap, and notifications render neither faithfully, so both are redrawn.
 *
 * NOISE CONTROL
 *   - Facts present in the very first snapshot are adopted silently: they
 *     predate this page load, and replaying them would fire a burst of
 *     reminders on every reload/reconnect.
 *   - Completion reminders additionally wait for the session list to reach its
 *     `ready` phase, so a reconnect's baseline replay cannot ring.
 *   - A pending request is deduplicated by its request key: the same question
 *     reminds once, a replacement request reminds again.
 *   - A child session (see above) stays silent unless explicitly enabled.
 *
 * SETTINGS
 *   The switches and the four title templates are persisted in `localStorage`
 *   and editable from Settings → Reminders (which is also registered as a tab
 *   under Settings → Plugins). Templates accept `{session}`; an empty template
 *   falls back to the locale default.
 *
 * MANUAL TEST / DIAGNOSIS (browser console)
 *   `__dshReminder.test('done')` — fire a "done" reminder now
 *   `__dshReminder.probe()`      — audio state, permission, counters
 *   `__dshReminder.getSettings()` / `setSettings({...})` / `resetSettings()`
 */
window.__ModuleLoader__.load({
  id: 'dsh-reminder',
  factory(require) {
    /** Bundle identity: the module-loader registration id and the Cordis name agree. */
    const name = 'dsh-reminder'

    /** Client services: Session catalog (titles, subagent origin, phase), Session status, copy, settings slots. */
    const inject = ['sessions', 'uiSession', 'locale', 'slots']

    /** Platform modules: React, and the host's own atoms for the settings page. */
    const React = require('react')
    const { Button, Input, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-reminder'

    /** localStorage key holding every user-facing option. */
    const STORAGE_KEY = 'dsh-reminder:settings'

    /** Notification icon: 128×128 PNG, clipped to a rounded square. */
    const ICON_SIZE = 128
    const ICON_RADIUS = Math.round(ICON_SIZE * 0.22)

    /** Reminder copy, keyed by locale. Title templates use the `{session}` placeholder. */
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
        titleQuestion: '需要你回答 · {session}',
        titlePlanReview: '需要你确认计划 · {session}',
        titleApproval: '需要你批准 · {session}',
        titleDone: '会话已完成 · {session}',
        tab: '提醒',
        settingsIntro: '会话需要你回答或批准、或者它的这一轮跑完时，这个插件会响一声并弹出系统通知。下面的选项会自动保存在本浏览器。',
        sectionChannels: '提醒方式',
        sectionScope: '提醒范围',
        sectionTitles: '标题模板',
        sectionTest: '测试与状态',
        toggleEnabled: '总开关',
        toggleSound: '提示音',
        toggleDesktop: '系统通知',
        toggleChildren: '子会话 / 子代理也提醒',
        toggleChildrenHint: '子代理由父会话派发，默认静默；一次 fan-out 结束时不会连续响几十次。',
        toggleAway: '仅当不在该会话时提醒完成',
        toggleAwayHint: '关闭时，即使你正看着该会话，它跑完这一轮也会提醒。',
        titlesHint: '用 {session} 插入会话名；留空使用当前语言的默认文案。',
        templateQuestion: '问题',
        templatePlanReview: '计划评审',
        templateApproval: '审批',
        templateDone: '完成',
        reset: '恢复默认',
        saved: '设置自动保存在本浏览器，刷新后仍然有效。',
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
        titleQuestion: 'Your answer is needed · {session}',
        titlePlanReview: 'Your plan review is needed · {session}',
        titleApproval: 'Your approval is needed · {session}',
        titleDone: 'Session finished · {session}',
        tab: 'Reminders',
        settingsIntro: 'When a session needs your answer or approval, or finishes a turn, this plugin chimes and posts a desktop notification. The options below are saved in this browser.',
        sectionChannels: 'Channels',
        sectionScope: 'Scope',
        sectionTitles: 'Title templates',
        sectionTest: 'Test and status',
        toggleEnabled: 'Reminders enabled',
        toggleSound: 'Chime',
        toggleDesktop: 'Desktop notification',
        toggleChildren: 'Also remind for child sessions / subagents',
        toggleChildrenHint: 'Subagents are dispatched by a parent session; silence by default keeps a fan-out from ringing dozens of times.',
        toggleAway: 'Only remind for completions while away',
        toggleAwayHint: 'When off, a finished turn reminds even while you are looking at that session.',
        titlesHint: 'Use {session} for the session name; leave a field empty to use the default copy for the current language.',
        templateQuestion: 'Question',
        templatePlanReview: 'Plan review',
        templateApproval: 'Approval',
        templateDone: 'Finished',
        reset: 'Restore defaults',
        saved: 'Settings are saved in this browser and survive a refresh.',
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

    /** The four title slots, mapped to their default-copy dictionary keys. */
    const TITLE_KEYS = ['question', 'planReview', 'approval', 'done']
    const TITLE_DEFAULT_KEYS = {
      question: 'titleQuestion',
      planReview: 'titlePlanReview',
      approval: 'titleApproval',
      done: 'titleDone',
    }

    /** Boolean options persisted alongside the title templates. */
    const BOOLEAN_KEYS = ['enabled', 'sound', 'desktop', 'subagents', 'onlyWhenAway']

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
     * The defaults, i.e. the state of a browser that never saved anything.
     * @returns a fresh settings object with no title overrides.
     */
    function defaultSettings() {
      return {
        enabled: true,
        sound: true,
        desktop: true,
        subagents: false,
        onlyWhenAway: false,
        /** Only the templates the user actually customized; empty means "use the locale default". */
        titles: {},
      }
    }

    /**
     * Read the persisted options, ignoring anything malformed.
     * @returns the settings to start this page with.
     */
    function loadSettings() {
      const settings = defaultSettings()
      let parsed
      try {
        if (typeof localStorage === 'undefined') return settings
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === null) return settings
        parsed = JSON.parse(raw)
      } catch {
        return settings
      }
      if (parsed === null || typeof parsed !== 'object') return settings
      for (const key of BOOLEAN_KEYS) {
        if (typeof parsed[key] === 'boolean') settings[key] = parsed[key]
      }
      if (parsed.titles !== null && typeof parsed.titles === 'object') {
        for (const key of TITLE_KEYS) {
          const value = parsed.titles[key]
          if (typeof value === 'string' && value.trim() !== '') settings.titles[key] = value
        }
      }
      return settings
    }

    /**
     * Persist the options; a browser that refuses storage just keeps them page-scoped.
     * @param settings - the snapshot to write.
     */
    function saveSettings(settings) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        /* private mode / quota: the options stay in memory */
      }
    }

    /**
     * Trace a rounded rectangle onto the context's current path.
     * @param context - the 2D context.
     * @param x - left edge.
     * @param y - top edge.
     * @param width - full width.
     * @param height - full height.
     * @param radius - corner radius, clamped to half the shorter side.
     */
    function roundedRectPath(context, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2)
      context.beginPath()
      context.moveTo(x + r, y)
      context.arcTo(x + width, y, x + width, y + height, r)
      context.arcTo(x + width, y + height, x, y + height, r)
      context.arcTo(x, y + height, x, y, r)
      context.arcTo(x, y, x + width, y, r)
      context.closePath()
    }

    /**
     * The page's own icon redrawn as a rounded 128×128 PNG the Notification API
     * can use. The shell declares an SVG favicon (notifications do not draw
     * SVG) and an `apple-touch-icon` bitmap (drawn as a square white tile), so
     * every icon source goes through the same canvas: load it, clip a rounded
     * square, draw, export. A failed fetch/rasterization falls back to the raw
     * href instead of dropping the icon.
     * @returns the icon URL, or undefined when the page declares no icon.
     */
    async function resolveNotificationIcon() {
      const link = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]')
      const href = link?.href
      if (href === undefined) return undefined
      const isSvg = /\.svg(\?|#|$)/i.test(href) || String(link.getAttribute?.('type') ?? '').includes('svg')
      let objectUrl
      try {
        let source = href
        if (isSvg) {
          const response = await fetch(href, { credentials: 'same-origin' })
          if (response.ok === false) return href
          objectUrl = URL.createObjectURL(await response.blob())
          source = objectUrl
        }
        const image = new Image()
        image.src = source
        await (typeof image.decode === 'function'
          ? image.decode()
          : new Promise((resolve, reject) => {
            image.onload = resolve
            image.onerror = reject
          }))
        const canvas = document.createElement('canvas')
        canvas.width = ICON_SIZE
        canvas.height = ICON_SIZE
        const context = canvas.getContext('2d')
        if (context === null) return href
        roundedRectPath(context, 0, 0, ICON_SIZE, ICON_SIZE, ICON_RADIUS)
        context.clip()
        context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE)
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
     * Whether one session is a child of another: a subagent (including a Team
     * teammate session) is catalogued with `origin: 'subagent'` and/or a
     * `parentId`. A row we cannot see is treated as top-level so a manual test
     * or a not-yet-listed session is never silently dropped.
     * @param ctx - client context.
     * @param sessionId - session identity.
     * @returns whether to treat the session as a child.
     */
    function isChildSession(ctx, sessionId) {
      const row = sessionRow(ctx, sessionId)
      if (row === undefined) return false
      return row.origin === 'subagent' || row.parentId !== undefined
    }

    /**
     * The template for one title slot: the user's override when present,
     * otherwise the localized default.
     * @param t - bound translator.
     * @param state - live options.
     * @param kind - 'question' | 'planReview' | 'approval' | 'done'.
     * @returns the template string.
     */
    function titleTemplate(t, state, kind) {
      return state.titles[kind] ?? t(TITLE_DEFAULT_KEYS[kind])
    }

    /**
     * Render a title template. `{session}` becomes the session label; with no
     * label the placeholder and its dangling separator are removed, so a
     * session-less test reminder stays clean.
     * @param template - the template string.
     * @param label - the session label, or '' when unknown.
     * @returns the notification title.
     */
    function renderTitle(template, label) {
      const title = template.split('{session}').join(label).trim()
      if (label !== '') return title
      return title.replace(/[\s·:：|/\\\-–—]+$/u, '').trim()
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
      let titleKind
      let body
      if (kind === 'done') {
        titleKind = 'done'
        body = t('doneBody')
      } else if (interaction?.kind === 'approval') {
        titleKind = 'approval'
        body = interaction?.reason ?? interaction?.toolName ?? t('approvalBody')
      } else if (interaction?.kind === 'plan-review') {
        titleKind = 'planReview'
        body = interaction?.questions?.[0]?.question ?? t('planReviewBody')
      } else {
        titleKind = 'question'
        body = interaction?.questions?.[0]?.question ?? t('questionBody')
      }
      // The manual console hook carries no session and no request: it says so
      // rather than imitating a real question.
      const manual = kind === 'done' ? sessionId === undefined : sessionId === undefined && interaction === undefined
      if (manual) body = t('testBody')
      const title = renderTitle(titleTemplate(t, state, titleKind), label)
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
      const stored = loadSettings()
      const state = {
        enabled: stored.enabled,
        sound: stored.sound,
        desktop: stored.desktop,
        subagents: stored.subagents,
        onlyWhenAway: stored.onlyWhenAway,
        /** Title overrides only; an absent slot follows the locale default. */
        titles: stored.titles,
        /** sessionId → { pending, running, unread } last adopted. */
        seen: new Map(),
        /** False until the first snapshot has been adopted without reminding. */
        primed: false,
        fired: 0,
        last: null,
      }

      /** The persisted part of the state, as a fresh object. */
      const settingsSnapshot = () => ({
        enabled: state.enabled,
        sound: state.sound,
        desktop: state.desktop,
        subagents: state.subagents,
        onlyWhenAway: state.onlyWhenAway,
        titles: { ...state.titles },
      })
      const persist = () => saveSettings(settingsSnapshot())
      /**
       * Apply and persist one settings patch.
       * @param patch - booleans and/or title overrides; an empty title deletes the override.
       * @returns the new settings snapshot.
       */
      const updateSettings = (patch) => {
        if (patch === null || typeof patch !== 'object') return settingsSnapshot()
        for (const key of BOOLEAN_KEYS) {
          if (typeof patch[key] === 'boolean') state[key] = patch[key]
        }
        if (patch.titles !== null && typeof patch.titles === 'object') {
          for (const key of TITLE_KEYS) {
            if (!(key in patch.titles)) continue
            const value = patch.titles[key]
            if (typeof value === 'string' && value.trim() !== '') state.titles[key] = value
            else delete state.titles[key]
          }
        }
        persist()
        return settingsSnapshot()
      }
      const resetSettings = () => {
        const defaults = defaultSettings()
        for (const key of BOOLEAN_KEYS) state[key] = defaults[key]
        state.titles = defaults.titles
        persist()
        return settingsSnapshot()
      }

      ctx.effect(() => {
        const dispose = ctx.locale?.register?.(NS, DICT)
        return typeof dispose === 'function' ? dispose : undefined
      }, 'dsh-reminder: dictionaries')

      // Resolve the page icon once (the shell's favicon is an SVG, which
      // notifications cannot draw; its touch icon is a square white bitmap).
      // Runs at activation so it is ready long before the first reminder;
      // `probe().icon` reports the outcome.
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
          const child = isChildSession(ctx, sessionId)
          // 1. A newly arrived request (question / plan review / approval).
          //    It outranks a completion: the session is not done, it waits.
          if (pendingKey !== null && pendingKey !== previous?.pending) {
            if (child && !state.subagents) continue
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
          if (child && !state.subagents) continue
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
        setEnabled: (value) => { updateSettings({ enabled: value !== false }) },
        /** Whether the chime plays. */
        isSoundEnabled: () => state.sound,
        /** Toggle the chime. */
        setSound: (value) => { updateSettings({ sound: value !== false }) },
        /** Whether desktop notifications are attempted. */
        isDesktopEnabled: () => state.desktop,
        /** Toggle desktop notifications. */
        setDesktop: (value) => { updateSettings({ desktop: value !== false }) },
        /** Whether finished child sessions also remind. */
        areSubagentsEnabled: () => state.subagents,
        /** Toggle reminders for finished child sessions. */
        setSubagents: (value) => { updateSettings({ subagents: value === true }) },
        /** Whether completions only remind when the session is not the main view. */
        isOnlyWhenAway: () => state.onlyWhenAway,
        /** Toggle that restriction. */
        setOnlyWhenAway: (value) => { updateSettings({ onlyWhenAway: value === true }) },
        /** A copy of every persisted option. */
        getSettings: () => settingsSnapshot(),
        /** Apply and persist a settings patch; returns the new settings. */
        setSettings: (patch) => updateSettings(patch),
        /** Restore every option to its default and persist. */
        resetSettings: () => resetSettings(),
        /** Set one title template; an empty value restores the locale default. */
        setTitleTemplate: (kind, value) => {
          if (!TITLE_KEYS.includes(kind)) return settingsSnapshot()
          return updateSettings({ titles: { [kind]: value } })
        },
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
          titles: { ...state.titles },
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
          ...settingsSnapshot(),
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
       * Settings → Plugins → dsh-reminder / Settings → Reminders: live options,
       * title templates, one-click reminders and the facts behind a silent one.
       * @param props - slot props; `t` is bound to this plugin's namespace.
       * @returns the settings content.
       */
      function ReminderSettings(props) {
        const translate = typeof props?.t === 'function' ? props.t : t
        const [settings, setSettings] = React.useState(() => api.getSettings())
        const [facts, setFacts] = React.useState(() => api.probe())
        const apply = (patch) => {
          setSettings(api.setSettings(patch))
          setFacts(api.probe())
        }
        const text = (content, tone) => React.createElement('span', {
          style: { fontSize: tone === 'hint' ? '12px' : '13px', lineHeight: '18px', color: `var(--dsw-alias-label-${tone === 'hint' ? 'tertiary' : 'secondary'})` },
        }, content)
        const heading = (content) => React.createElement('h3', {
          style: { margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
        }, content)
        const section = (children) => React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        }, ...children)
        const toggler = (label, hint, checked, onChange) => React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
        },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          React.createElement('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, label),
          hint === undefined ? null : text(hint, 'hint')),
        React.createElement(Switch, {
          checked,
          label,
          onChange,
        }))
        const templateField = (key) => React.createElement('label', {
          style: { display: 'flex', flexDirection: 'column', gap: '4px' },
        },
        React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, translate(`template${key[0].toUpperCase()}${key.slice(1)}`)),
        React.createElement(Input, {
          value: settings.titles[key] ?? '',
          placeholder: translate(TITLE_DEFAULT_KEYS[key]),
          'aria-label': translate(`template${key[0].toUpperCase()}${key.slice(1)}`),
          onChange: (event) => apply({ titles: { [key]: event.target.value } }),
        }))
        return React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '18px' },
        },
        React.createElement('p', {
          style: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
        }, translate('settingsIntro')),
        section([
          heading(translate('sectionChannels')),
          toggler(translate('toggleEnabled'), undefined, settings.enabled, (next) => apply({ enabled: next })),
          toggler(translate('toggleSound'), undefined, settings.sound, (next) => apply({ sound: next })),
          toggler(translate('toggleDesktop'), undefined, settings.desktop, (next) => apply({ desktop: next })),
        ]),
        section([
          heading(translate('sectionScope')),
          toggler(translate('toggleChildren'), translate('toggleChildrenHint'), settings.subagents, (next) => apply({ subagents: next })),
          toggler(translate('toggleAway'), translate('toggleAwayHint'), settings.onlyWhenAway, (next) => apply({ onlyWhenAway: next })),
        ]),
        section([
          heading(translate('sectionTitles')),
          text(translate('titlesHint'), 'hint'),
          ...TITLE_KEYS.map(templateField),
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
            React.createElement(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => { api.resetSettings(); setSettings(api.getSettings()); setFacts(api.probe()) },
            }, translate('reset'))),
        ]),
        section([
          heading(translate('sectionTest')),
          React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            React.createElement(Button, {
              variant: 'primary',
              size: 'sm',
              onClick: () => { api.test('needs-you'); setFacts(api.probe()) },
            }, translate('testNeedsYou')),
            React.createElement(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => { api.test('done'); setFacts(api.probe()) },
            }, translate('testDone'))),
          React.createElement('p', {
            style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
          }, statusLine(translate, facts)),
          text(translate('saved'), 'hint'),
        ]),
      )
      }

      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'dsh-reminder',
        order: 50,
        label: () => t('tab'),
        locale: NS,
      }, ReminderSettings)), 'dsh-reminder: settings page')

      // The same page also gets its own row in the Settings nav: a tab inside
      // the Plugins section is easy to miss, and "Settings → Reminders" is the
      // one path a user looks for first.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-reminder',
        order: 90,
        label: () => t('tab'),
        locale: NS,
      }, ReminderSettings)), 'dsh-reminder: settings nav row')
    }

    return { name, inject, apply }
  },
})
