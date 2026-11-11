/**
 * Session notifier — the browser half of the unified notification plugin.
 *
 * WHAT IT REMINDS YOU ABOUT
 *   - a Session is waiting for your answer, approval or plan review, and
 *   - a Session has *genuinely* stopped: ending a turn is not the same as
 *     waiting for you. Goal rounds, queued follow-ups and a settled Subagent all
 *     restart a Session by themselves, so a completion is held until the
 *     Session has proofably gone quiet (see `createCompletionGate`).
 *
 * CHILD SESSIONS
 *   A Subagent (including an Agent Teams teammate) is catalogued with
 *   `origin: 'subagent'` and/or a `parentId`. Its completion is not news — the
 *   main Session reports the outcome — so child completions stay quiet by
 *   default. A child that stops to ask or request approval is the one thing the
 *   user must act on, so those still notify, labelled as a Subagent.
 *
 * DELIVERY
 *   - A Web Audio chime (interaction and completion have different two-note
 *     patterns, 900ms cooldown so a burst cannot become a siren).
 *   - A desktop notification through the page's Notification API. Every alert
 *     gets a unique tag at most 16 characters long (a Windows cap: longer tags
 *     make Windows refuse the toast silently), the previous notification of the
 *     same Session is closed first, and `requireInteraction` keeps the banner on
 *     screen. The icon is an embedded DSH PNG redrawn through a canvas with
 *     rounded corners, so no page asset route is involved.
 *
 * NOISE CONTROL
 *   - Facts present in the first status snapshot are adopted silently.
 *   - Completion candidates additionally wait for the Session list's `ready`
 *     phase, so a reconnect replay cannot ring.
 *   - A pending interaction is compared by its request `key`; the same request
 *     alerts once, a replacement request alerts again.
 *
 * SETTINGS
 *   Every option and the four title templates are persisted in the browser
 *   (`dsh.session-notifier.v2`) and editable from Settings → 会话提醒. Legacy
 *   keys from the two previous plugins (`dsh.session-notifier.v1`,
 *   `dsh-reminder:settings`) are migrated on first load. Templates accept
 *   `{session}`; an empty template uses the locale default.
 *
 * CONSOLE / SERVICE FACE
 *   `__dshSessionNotifier.probe()`, `describe()`, `test()`, `getSettings()`,
 *   `setSettings()`, `resetSettings()`; the old `__dshReminder` alias is kept.
 */
window.__ModuleLoader__.load({
  // Must equal the package name: the client module loader keys factories by
  // the bundle row id (`dsh-session-notifier`) and executes the batch script
  // once. A mismatched id makes the row look unregistered and re-loads the
  // one-resource URL, which then throws a duplicate-registration error.
  id: 'dsh-session-notifier',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'session-notifier'
    /** Current settings key, plus the two keys owned by the merged predecessors. */
    const SETTINGS_KEY = 'dsh.session-notifier.v2'
    const LEGACY_DESKTOP_KEY = 'dsh.session-notifier.v1'
    const LEGACY_SERVER_KEY = 'dsh-reminder:settings'

    /** Every persisted boolean option with its first-install value. */
    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      sound: true,
      desktop: true,
      skipFocused: true,
      childCompletions: false,
      childInteractions: true,
    })
    const BOOLEAN_KEYS = Object.keys(DEFAULT_SETTINGS)

    /** The four title slots, each addressable through settings.titles. */
    const TITLE_KEYS = ['question', 'planReview', 'approval', 'done']
    const TITLE_DEFAULT_KEYS = {
      question: 'title.question',
      planReview: 'title.planReview',
      approval: 'title.approval',
      done: 'title.done',
    }

    /** How long a finished turn must stay quiet before it counts as "waiting for you". */
    const COMPLETION_SETTLE_MS = 1200
    /** The same window for a Session with an active goal (waits for a durability checkpoint). */
    const GOAL_QUIET_MS = 15000
    /** At most this many desktop notifications per status batch. */
    const MAX_NOTIFICATIONS_PER_BATCH = 4
    /** Minimum gap between two chimes. */
    const CHIME_COOLDOWN_MS = 900
    /** Notification detail length cap. */
    const DETAIL_LIMIT = 160
    /** Request identity fallback when a pending interaction carries no key. */
    const NO_KEY = {}

    /** Embedded DSH application icon (96×96 PNG); the notification icon is redrawn from it. */
    const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAk2ElEQVR42u19eZwU5Zn/9z2q+pjunhlOOURAARVU5PCMwOhuYhJdNcJgPGKiBPEggooH6nbIupq4McFgjJAYTXYxccjvp/FIomjwBhEUhVFBo3KjwzBHT3dXV9X7vvtHHV3d03MPo0m2PhTT09Ndx3M/3+d53iLonY0opfDPtBFCAODzu2mlFFVK8TVr1nAABP98G1mzZg1XSvGamhrW3YPwbpyUvfDCC5IQIgFI7w/r1q1LVFRU6P8MlG9sbDRPOumkVFVVle29l0wm6YwZM2hVVZXoimZ0WnJrampYbW2tWrJkiQSAVCp1rKZpZ1BKTyGEjAUwUCoVzqtIt3Wrc19X3Tlqr5kfA4TUEaW2KYLXMrnc8/3i8Xc8RowfP55UV1eLXjvf8uXLNe+XXC43y7btv9q2bas2NhncZU92qURHu+jabvfCLovuN2datmmaazKZXLUn1C7NSI80QClFXnjhBVZVVWU3NTWdVFZWdjdj7DQAsG0bSinbPQYpPpbqFfH7QmuD8nZCCA/pjoyatv2KkTEXlZeXrVuzZg2fMWOGIISoLjMgqEqGYdzAOb+LMcYtyxKuGtIOGdhrd94JRnyOJskVVgEA4ZDObCHsnGkujkWj/1VsujvlhAMOxTYM4xehUGieZVlKSikIIayrDkYF3+jWnRP3fwXV6ZN18dp67hcYABg5UxACVhaJ3J3JGKOj0fCVbqSIUkwoJcFkw4YNfMqUKZZHfNu2LaUUJ27w230Z/qfRBkUIsUO6pqWzuQdi0fCVGzZs0KZMmWIXn44Wf3n58uV8ypQpViaTucGVfAuA1hPio5STID07EunSybp4bT3XBgJAy5mWVRYJzWtoalo0ZcoUa/ny5bxdDVizZg2vqqqy6+rqplZWVq5VSkEpRXtK/A6l7h80ZFVKKUqJpISirrHh5KEDB77h0biUBpC6ujpVU1PDEonEMsYYU0rhYBAfB0EbSK9kOz28nBKaIKUC54xVxOLLampqWF1dnQqewn/h2iirubl5ZjweX2VZVpcc7v9pQ/sRUjiks/rGxlkDKiv/sHz5Bu2KK6ZYQQ0gH330kQRAdF1f0NcgE+kVg/zF1gYAKqyHFwAglZUOrX0G1NTU0OrqarFjx44JnPOTbNtGX0n/wXHS+EI5aUIIMy0Lus5P2rFjx4Tq6mpRU1NDfQaMHj2aAkC/fv2+4tp+gc9p+0fVBimV0Dhn5ZWVXw7SnAIgGzduBAAwxk7xIIjPFef9BwxZvVhGY/wUAHBpTnwcZ9asWWTlypWbNE2bYFmWdKGGz337R0nglFIyHNJp1jC2RCORiR6ORJPJJAEgL7zwwjiAgb3ve/5PG/yqIQBC6IDHHnssDkAmk8m8lA8aNEgH8IUtqPSOb0DnfQPpfd8gpQKAkEvr0lDEF3nrU21A3/iGvysGlLzZL6A2kH90BvQWnCGE8MxCr2pDVz7O/16J7wKFcLphnDoBIQS0E8GbUgpSSoTDIQBALmeCUtJxjeAg1Bz43xPBHUcmIaUCpQScczCWT9iFlHCz+DYtvEf8UEjH6udeRDwRwwlTjodpWqCUgRCn8NMhI1TXtEF9kRjgEdOTYue1d8vEyU4CPz2iUUoQCoV8RtTXH8D++gNIpzNgjGLo0CHo168SUimQNsRPSglN0/DxJztw25IfYvSoEXjwgaVgjEEpiXylVbVP525oA/k8GeARW0qnKkcpBecclNJ2bbQQAprmfM62bWypfQ+vrX0Db256G9u370JLOu1l8WCM4QfJm3HKSVNhmiYoYwXi55xfgTGKx/74Z9iWhT179mHbhx/h2AlHIZczHe0hpKAM2llt8O6xvXsifc0Aj+hKKei67l9cNptF3f56NDQ0ojmVgpE1IKQEZwzRaASJRAL9KisQj8exd9+neOnltVj93BrUvrcV6XQGuq4hEgkjpIfAXFM05zsXYcL4I2FZFiiledoEpJUxilQqjfUbNkLTdbS0pPHEk3/BxGPHQykF2xZgjIFSUkDh9rRBEQUpJDjj4Jwjl8sFGPk5OWFPGoSQiEScfq1du/Zg3foN2LDhTWz78G+oq9uPlnQGlmVBCuljJowx6LqGeCKOfpUV2PdpHT77rA6a5hC9PBEHCHGYSYBMJoMF8+fhgupvwDCMAuwlSDipJHRNw/Ydu7Bn7z4ACqFIGE88/QwGDx6Iy799ITjnMIwchHC0tD1t8MynbQuEwyEcaGhEfX0Djhg90vVFHcdD/GARXwgBzjl0Xcc7m7fgd4/+P7z08quoq6t3QCmNg3MNlFGEQnphYqScrPHAgQP47LM6cK6hvLzcNyGWskEJAdE0GIaBEcOH48wvVyGTyYAx1krygkyglOJAQwOyWQOccwjbBmMM9y9/COvWb8Tsmeeiavqp0DQNuVzOd/KEECgFKOVos/LvUyIWi6Kurh633H4ntu/cjfvvvQuHjxoJ07TAWB8zwFFjG5FIBPv312PZz5fj8SeeRiaTQTQaRSIRh3IJrJSEkgpCCV++gopPCUNI51BQsG2r4K+KAFII2EKAu8xUysMX27C9LhdM04QUAooxSCEAQhCJhPHW25vx5lvvYMqk43DLjdfi8NEjYRg5x/8IAUYpdE0HoYXn+PCjT/D9O36M7dt3gnGO3Xv2YewRo9trojk4DJBSQQiH+OtefwO3J+/ARx9/gkQigXgiASkEnCYLBCKfIIWIf8mk2G25FPRMgsNEAY1zfPDhR1i/4U2cUTUN6XQamqYVmKHiQ+m65pivQDRm2zZCug7GON7YuAlXL7gZy+/7MYYOOQS2bSMajSCXs/C3j7djf/0BKKVgWRY2vb0FTzz9LFoyGZQn4pBSol9lBaSUeaxZ9QEDHHV0iP/4E0/j9uR/QAiJiooKp41RiBLEDfzmhaGtGOHqhfdDKbcpm0IR4jv4u+5eCo1zTDvtFJimCSEkGKMFTCBuGFpRUY5wOATTtAoEwYu64rEy7NixG0uXrcDSH/8HLNvG72sexxNPP4NPtu9EJpN1rwWQQiKRiKEsEoZpWqioKEf//pWwhcifux0m8N42O489/iRuvjWJcDgMzjksywrE+F7UEEyTVCFLlA/cFqD4jgK47xEASkJKCkUcQjccaMS11y/GhRecj2uunINQKIRczgTneZ9ACIFt2xg0cAAGDOiPHTv3gDMKoiSkc0gQQpAzTUSjYbyx4S2sXbcBD//Po3j+ry85UVcoBK8PlDLmhNKuqAvbwvBhh6B/v0o3mqIdJgK0N4n/8iuv4bbkDxAOhUEJhbAFlCoYI/Btj1IFLCkUEeWJpSpdTpHOlx2HKCGEAKUEuq7jod8+givn34A9e/YhEgl7TcRwW2wghEBlRQXGHz0Otm2BMhagjfIdvVKAaZm47sZ/x8uvrEO/fv0QDkecACHghJWSAHHCWyEEJh4zHpFwGG1ODJHeZIAb42uahl27dmPx7UugAFDq3GhhBqNa15NUsZtSJUpOpZiQx4H8cFcKCNtGeSKBN996B9+9aiFq330fkUgElm23Kg2eMWMaOHfjfUJaMcHLCYxcDtFoBLZt+0kk3EybMQpKKJjrT8oTcXzplBNh2zYYJZ0C5GiP+7OVAiEUd/3oHuzduxeRUARCSjcCUAVxdElD2EVtKHilFJTME0wqCdM0EY1Gse/TT3HNtTdi45tvIxqJwLJsP0vN5XI4+eSpmDzxOGSzWXCNuybCY0T+LJRS36ESokAoAXWzbkoIKKPQdR2ZTBbTTjsZRxw+KoArdcwE2lPTEw6H8ac/P4NnVz+H8kQCtrDzWaCDbIESJ8p33i8VKSrvX/e0QRYywrJyCGk6mlMtWHjDrdjw5iZXivPhrq5puGreZYiEwlBSglHm/IUENMKNvCglDrEpBWMUnDEwykAZg65pME0TQ4YOxsUXzIRt2wEoouPujB4xgDGGVEsLfvXgw9A13dEGOOpJKfF34r0mtIgRQdRSdU4bSv7V/d9jAgDLNsE5RzqTwfU33o63Nm12mWCBMYZcLoeJx03A9QuuQiZrBDAc9/iEOkQnAIUj6ZwzcM7AOAXXGMKhEGzbyUOuv/ZKHHLIINcf0aIQuO1eJdr9kFNC13WsXv1XvPf+VkTLolAKoITmd+ruhIJQkmeMi9sTAhCKItykA99QwkE7oqq8H77Pt10mtLSkcd2iW/HO5lpEo1HYlgXOOTKZDM479+tYfOO1sCwLOcN0MmwCEOqExIRQMM6gMQZOGTTGEQrp0DUN6Uwa5eVxJG9dhKmTJrqZM+9SGbTbGkApgWVZ+OOTTzs2FI5TYtwBpDRNg8adnWuaCzswEFc6qLsHzVIBI/xiS9vaQFwfQ0DypqPI3QjbgqZxNDWnsOD6xT4TLJ8JWVTPPBdLf3wHDjlkkGNCCAFRboGHUTDGHOhEc7LybDoL07Iw/bRTcM+PluDEqZNg5HLgXPPvo7O1Mt69jNeR/tp330Nt7buIRqIAIY6KMhaIUAKEpU72KoSEkAJKqDyuQoqyYh/oUlDK8SOl8wbiMCEQyRQnbwoKtuUwobGpCfMX3oy77/w+TjxhMjKZDCglaE6lMH3aqXjv/W34yb33o7KyElJIJ8JhDuCXzeUQjUQweNBATBh/FM44fRomHX8sCIibb3SG+B0kYqqV1LUNLxNC8MYbG5FqaUFlRSUAB4DLGTlEo1FEImFwxmHbNrJGFkbagFTKUWdNA9WowwxbONksJBTxzk8KGaGcVIwE0Lp8ckX98NF5Td3MUxUojrBtaBpHcyqF+Qtvwg0Lr0H1zHMhhIBl2zAMA5s2bQbnDEpKB21lFJBAvLwMc75zMUaNOgxDDxmMAQP6A4Qgl8uBUgZN545GEtKzQW0ViINRcMOt2+yUUnj7nc3gLnZuWRaGDxuGb35zNkYeNgKJRByapsGyLDQ0NGLXrt348G8fYeu2D/DJJzvQ2NTkgFshHQCDbQlIKaCgXEYQuHRoUxuC10eUYyooo27JkromyPaZKCwBjTEIIZD8wQ+xdt0bmDf32xg3dgx27tqNTZu3IByOOMEEJWCEQEiFRDyOr/xrFcLhMCzLdoo9lELjvE3T171JeZW3tAR5aQzeqFJObJxKteCT7duhaZqTvudyOOecs1E98zwYhlEQirEjKE46cSqklEhnMti5cxc2bHwLL738GrbU1iKXyyESiQCKwbJsSCkAopDHy4jPBKhCKIMQBeJGKZZlQVkK0WgEhpGDZdmIRqOO1goBuDA5oQTxWBR/+stqvPzKWpx33lkwjByamlMoi0adZNINoRmjMC0TqVQLOOcuY3gBvNGTQUReMtRW+UpSa0YoMM7R0LAP9fUHwDkDIP2kQwgB27adi3XDEssSkK5T0DjH2DFH4OijjsTM887B25u34I9PPI0XX34VhmEgGonAtimEbUP647UqwATXQQdUwcF4LIweNQpzLrsEgwcPQv2BBrzy6lr85dnnIaRTmxCWBUBBSgdOiMdjsG0bDz38CDhniEajTu3Zz18IpFKIhMMIh8O+UJWqdpFiJnRSG3irrNRr8fA0guQdm4fj65SisakZmUzWTcOd7zY3N/u1WQ9j8TZW5EOy2SwIJThh6mRMnTIJb216Bw//diVefW0ddF2HpuuOREO6UaXyYWh/oRIFKEVAGEU2k0H1rHPx1TP/1Q8UqqZ/CWdUTccP/vNu1Dc0QNd02JbpmjNA2A5iWV4eL8CLfIdOCIQtMGjgAMRiZRBClCz49GQsl7aGFgoZEdQIFSjDZTIZWLaV/w6A/fvrC6NeP8ws3Cml0DTNR0tN08Sk44/DT/7rTty++EYk4nFkjSz0kA5CKGg7WbRXfYuEI3j4t4/gxlv+HffdvwI7du6CaZo49ZQTsPSeOzFwQH+Ylgnqx+lu0iZVAOdRXvLuh8pCCBw6fCg0TUNnl+TpSuceLZXvdMQIAI50uhctpASlDHv37oNpmu1GA8XM8HIGy7IghMD555+D5fffiymTj0cqlYKmO2XLIBMKLhQOKkoJwb59n+G997fhoYf/BwuvX4zm5hZkszkcddQ43PWD2xEOhfwIzsvalJJFKYZynSpxmE8IRo06rFvtcZ1pKC7SgHz83iYj3Pc8VXSkSIJxht1796CxsQmc805JSylGZNIZjBhxKO79yd2onnkeWtItYJyDMhfGAPF9i4LywcBMNoNxY4/Ak4/9HnMuvxSbN2/B1m0fIBYrQ6q5BZMnH49rr77Cjf1pPowieTvhoTaUutEXFCKRCEaPGukwmZJebyimRS4gAPcWCVoAApBK+U5JuigkYwx1dXXYsXOn2+SkujQ94u2apkMIG5QS3HrLIlw5dw6y2QyoG+4SD9jzDWweEt+9ezfu+/kKvPTKa6iorEBFRbnfBZdOp3H++efgjKppSDWn3GK5CjDCzaydmAqMUtjCxuDBA3DoocNgWXanW0260phFS6DDgX7LPCN8fijHLsbjcYRDYTeRcpxXJpPF5s1bQAKlwq6O8RACp8rEGLKGgavnzcH3rrkSWSML5oaBQSDPK4pQStGcasG99/0C7723FZrGoWuab3I8qb/6yjlO9GOJVqGKchWCEoBSBtu0MXbM4aisqHDC124Sv73GLNoWANwWI0CcULM8kUB5Ig5h22587bT1rd+wEZZlty66d1EbmJvotKTTmHPZpfjuZZe6BXfdFScVwO6UbyIqyhMI6TqamprxzuZacM792m8mk8GYIw7H2V8/E+l02mnkVYHzwoFMCCU+KDfp+ONc5vWc+J1wwnlMXbXBCMDVgEQcgwcPgrCd2Fq4XQWbN9fi40+2Q9N1SOnG/90cavOipXQ6javmfRf/dtZXHces6fBTYteSKOmYIkvYsG0Luqbjvl/8Eq+v34BEIo5wOIxYWRk45xg79ogC7fSKMN45CaUQUqJfvwpMPO4YF+M/OAzgbQ6eeUxwY2IViBKklIhEohg1ehTWrlvnmxxKOQ7U1+PFF1/C2DGHu1gJzbs40j0mMMZg2TZuWnQdPv5kO2rf24qwrsNye4WcujOBcnv9hVuob2xowNXfux4XXzgbp5x8AoSUWL/+Tfzh//8RkUgYUooAgBYICBiDkTNx6jEn4NDhw2CaZiCxPEgMaAnA7C4U5CZjqiD1DzJi/PijQdwihlMct6FpGv7yzLOorp4JXdcdXIaRNqGNzjCBUQZb2IjHY7ht8Y244srvwXCZK6WEcqMxt1kCIICtBDRdg2XZWPbzFfjlg7+BUgpZw0A0EnWgZTfxIm7WSykF835SgjNOn16iuHIwTRAK4/684y00S4RQmKaFCePHo7Kiwi31Ob4hFArh/a3b8MILLyISDkEI4VaqCsG+Llkm1zEbhoEJ44/G1VfOhZE1wBkPVNi8Sm5hggUolJc7wKCu66goLy9APD0IhTDq1zNM08TYMYfjhKmT3OEN2jcMCIabpSMg5UulaVkYMWIEjjrySL8b2NMCRgl+97tHkWpJO+ZJBZjaDUZ4EqhpGtKZDGbNPA//csYMpNNp1zQUQsHSrTNABjNdB/YWQvj23wf0qBN2UremYdsC55z9NcTjcXdmgBw0LcgzoKWY2AHHW8wIAEpKhMNhzKiaDimFH1EIIaCHQnj7nc148qmnnTqsZUP5nRIoKsAXaldnoiMAWHDtNRg0aKCDzxDqO9E8BKMgA9qg3F5UP+nySqKuyaGUgmscRi6HCUePwxlnzIBhGAUTOH2gAapEFoyScASlDIZhYPq0aRgyZAgs23KyR6kgbAE9pOPBBx/Crt17oema06oii0ycKnL6ndAGxhgsy8KokYfhmqvmwjRNMK652I2b2BJScE/FEYZfi4bjX6inAW4ryaXfutCBpRUOqvS3YoBUrU1DKTjCs7umZWPYsGE48ytfRtYwwDh3oiQhwBnHrt178NOlP4PGnYRIutJYjDEVmyUhJGzbgbULTIZLCK+gfs6/nYUzv/IvSKfzoamXI5MiJgS1z/8MdWu+lELXNaRaUjj7a2fi1FNO6hPpbzsTRucYwShFzjTxjfO/gcGDBsG2hR8V2ZaFeKwMTz/9J/z3ykcQj5W5zVFtg31KOYN2msYRDocQDju9mLZXtgwwglIGKSUWLrjGhQryoSIp6OspdOYkkD44pseZVchkDRw1biy+e/mljlYx3q0ab8+dcIAYaIcRngSZpoWRh43E7NnVyGYz4DwP99qWhUgkgp/+9F6sfn4NyhMxmJbpzOaq1k5fCKfd/L33t+KqaxbgJ0uX4YMPPkQkEnZnxESgK8P5feiQIbhp0fV+S6SDF7m7at0GotyRIi/zZZTBtm3EYlHcvGihO7+g/OP0rQa0mQUHasVFAB1nDJlsBrNnz8axxxyTb/XzC+qO5C5efDteeXUdyhNxWJbp+ASvydU9l5QOqPfGhjfx1NN/xq9+/RtcfOkc/PBH96ChsclvtvVaBTlnyGQyqJoxDXPnfBuplhZnDs2TdEoCtQm0KiESSvwo6eZFC3HUUeOQc5Ouvtpoyc6bUowo4ag9OFcphbJoFAuvW4hwKORIkNua7RCVwDCyWHjdDVj93BoHQxJ2QY7gHU9KhcNHj0JFRQXiZTGYpolfPfQbXHzJZXjmmdWIRCIgvjYQB8LOZPDdy7+Dr3/tTDQ2NUPTdR9p9hMp1XroQymFxuYmzL96Hk6vmo50OuMU2oE+kf7WDJAlGIGOY3jKOLJZA5MmTcJVV1+FTDrjF7ABuBOEDDnDwHXXL8LDv1mJsrIYKGVOVU3JPKJqGJg48TiMG3sEGhrqnUQqHseuPXtw7fU3Ifn9O5DNZHxt8M2RELh98U04cepkNDU7TpkABaEmIXkImxACwzCw4NqrcdGF1W45te9XbmgHjm7fWaqiEhrXnBbA2bNnY/YFF6C5qRm6np+ncjTBSfH/8867cNPNi9HU1IxYLOYW8i0n+rFsaJqOyy/7DrjGIYSAaZngjCIaDmPl72pw6XfmYtPb7/gNt46EOzWKu394B46dMN5hgq8JqgDCJm4eo2nOSOm2Dz5ELBZzOjPcqUe/Fb1PNaATBZlgoqZUYX8OYwyGkcOCBdfia1//OpqamqHrIaeaReDfVDxWhscfewyXfOtSPPnUn8AYRzweQyQSRjgcAiEE0077EoYPGw4jm/VhDsu2kEjEsHXbB7js8ivxyO9rEI1GQNz5NMu2UFlZgXuX3o0pkyaisbEJmhYCZdztSYULM1OfGff/4pf49uXzcN2iW/Dc82vcYZOwDzAe7I3NmDGDvPjii+qSSy4vGzJ08DWU0oiD7ftNHwiOu5JAQ2xxY4YriFBKYdq0adi371Ns3rwZ0UiZm1HnhyoikQgaGhrwzF+exbrX12P//nrkcibSmQz27N6NX/7qQbz++npoReVNr/olpcSzq/+Kz+rqMHXqFCQScQCAYTg9RqefPh27du3Bltp33XEprSDr9fZoxJlm+ejjT/DXNS9h3esbIKXAyMMO80urveUPGGNESmns2bPnvl//+tfpGTNmkIC7b2nleL3GJ68SRhBoUymCq32VYtQZAVXAbbfdhvLyBB59tAbRaNQN+Sy/k0HXdeghYNOmt/D66+sRcmN/0zRhGIbfJOUjnU5XmD+SlEiU4feP/gFvbXoH37r4mzjtS6dg0KCBoJSiLBrFfT+7B79+6Lf475W/QyaTBdc1UK+OrQrR1nA8DMoZdu7ahTt/eA927tyFhddeU9Rk1gf1AAT7Y7rMCAKilJskCQhhY+HC6zBs2HA88MADMC3L7am33MTKgS6i0SiiUeL3impcg57QnTGnQM+lZ+vhAnwQAuXlcWzfvh3//v07MHTIEIwbewQOG3koKioqoGshRMsiGDpkCLZv3wEFoKUl47bEsDz8QAmkkhCmdDowCEE4FO4TH8BLZ8Fo1R+q/AnSACNI/vPE7XL23qSUAcQJP7/5zQswZswYLF26FFu3bkVZNArGNV8bPKDMmbtyV0cRXpNU6/GGfPGc+Ov+lJWVoTnVjLWvr8fadeudjj1K0NTYhBNPPAG/uP9naGxoxKuvrcXH23egvr4eLek0LNN0kVYdiXgcAwYOwOTjJ2LWzHP9HtC+YwCKCzKFRRSVb5vxm2U9/6ACPfvemxQUhGtoSadx/PET8bNlP8MjKx/B448/jlQqhWgkAuIO9MnAiBEC8HXQvhVUrvz6LXUjLYVwWIeuxUApR9bIQuMcF194Ab596cWIRqIghODUUx2cpyWdRktLGtlsFkophEMhxONxxBNxRMNh5FzGHOx8oERrYn5Ut1V/aFF5stgs+fPURUPXGteRy5mIhCO4+uqrcPrpVaipqcErr7yKllTKmThxZ2+lVCU6KvIRQLAAEyxZMrcruiWdBmUUxx93HL51yUWYOnUKzFwOtm2BEALLMkEIRSKeQEV5uS/hXsuklNIBFt2+pz5lgAokAsq92YL+0DbqxG37B/i/M86h3O7oMWPG4Lbbb8f7772P1c+txutr12HPnj3O/JY7YcMYDzh44tdISeDYUjnLxBimCQWgoqICU6ZMxlfP/DJOOulEhEMhZLOOJhB3+ZrghXvBQEH5k7FWnc99qAEo1AB3Yt3vAOkuI/IIGjSiu4mOhXFHjsP48Uej7qKL8G7tu3h70yZs27YV+/btQ3Mq5S6qkS/kOGbHHRnSdcTKytC/f3+MGDECx0wYj4kTj8OokSPB3ZVOcqbpED/QbEsCM2UASqzQ1bdbgAGxVgUZz6Yr7wIDjCCBNvGgo+6IEYrA7XKjsC0bZs5EIhHHtGnTMH36NGSzWRw40ID99fvRUH8AzakUcrkclJLgnCMajSIWi6E8kUBlZSUqKysQi8fBmYNq2rYFIYULJ5NCJA7u9ebt2ee+RLDPgD2Zz8wJONrMT6QUOd4iRrQ9P9A6YiLBNR78hVGcgWfKGKAUcjnDD38HDRqIIUOGuBOWeQJ6USj85c8cyMDMmbAIcaAOxos6qUm7AtXefRykLffZZ5+ZxS2LZBZmkaWfrtgUjZZNyGTSgcW7Cy+IBP4LtmCToowYrcaI2sioS8zft1qOEoXHy0dBNPB7YNI9wDC0dV1dvA/0fE0NqWkazeVyWy655JKJq1atchbvBoDly5ezVVglpJQfaA6WrwoJ0hYu1A5S2tle08KBAgencSfSGXOmLpm7FpvnnJ0pdZrHdVA4Jdl2PQMdtuD3qH2mgwf6uD8/WLVqlVi+fDnzwbjKykriAF72a+4SW6pkv5Bqp3Oig16ijpt+82EwCTwdkQQG4PzWdH82OFB278a5uyRQqscP9FEuqPhakObebL4AgPoDDc82N6fbeXhPCeK10znRPUa0XZUr1bXRvWN1LAToQLO78xgTIYQ4cODAM+5bwjdB1dXVMplM8snHHrnZNI11sVgM7T/GRLXRwtL2RE1x24lShRrUKeK1IZGFx+olIUARI9pc3aVzT1HinMO27XUjRoyoTSaTvLq6WhbUA4YOHUoAKMM07qWMdvIR5R13TrSnzqoEIwpsNLpzrI6EQLXfgt/ZQlTXzRJJp9P3ApBnn302KTUvQJPJJAWAOVd879XyivITUqlmQQhlXVoOvicRU/Hne/NYHUU5vXmsIunXNI2Zpvn6nXfe+SXAf6inLK6Iqb1795IlS5bYTanG+ZZlCsa47707u4RTjyImdNZZdr59ptW50YZNPwgRk/tQT7i2/3tLliyxPUtTqiSpVqxYYSeTSX3CuMPXNzU03VJZGWeEELur62i1HzGh21FLZxx1qfaZ3nDUpQQK7TDCvR6bc84Mw7hlyJAh65PJpH7FFVfYpWa6C6LxZLKGL1lSbe7Yvf+BQ4b0v2L//qYePM62q+rcusrWYTLX3ueLlw7tybE6+XnvcbaapmnZbHZ5NBqdV1NTo1dXV9vF6+7QUo1j7767SiSTSX3EsAHzPq1reKBf/3LNHUkV3VlZrmuOunWk0VcRE3pBG6VUwu1X0tLp9PJoNDovmUzqq1atEmgj/ywptrNmzaKVlZV0xYoV1o699YvKopE7NU3nqVSq0480P7iO+iA4/RLa2GpNiLa0y3ukeTjkPNLcMG6NxWJ3z507V2toaJCrVq2SpRYu6GBpp1k0mTyaLVmyxPzg410nV1ZW/igcjpwmpES6pQVKKTuIJ31ejCBFduFgMKKEqVEu3qsIJTwc0r11qV9paWm5sX///muTyaT+7rvviraI35nZewKAzJ8/X1u2bFkOAN31WePMMNfmCSWnxeMxJiVgWSZsf5HWrj/FqBThWhO5F2x0N5hQ6liUUvDAqug50xIEeNk0cw/E4/FVAOT8+fNDy5Yts0qZna4+7IcAwNy5c/nGjRuxceNGCwC2bP14Yr/KitMpoScrYCygBiqJsOru8HLRGs+lpLs14UlgBa0ixtGi9QpbEdP7CEFBjaa4CaCEJlBKDCi1XwHblLDXNjU1PT98+PBNADB9+nQ+btw4smLFCrszi9aQLg54k2QyyZ966inlMcKrK6xcuTKuaVqob8sZ0RLvZdp4vwuHKjpE1H3Le93U1JS76KKLUgD8EH3y5MnaWWedRZYsWRIMM1UvPx2rgBF0/PjxtLa21svsRF8/CBqf7yPMmEsD1NbWSpcGnSZ8Tx8GSEpETQT/RJtXUOnps17/F3qK/fVq4ThDAAAAAElFTkSuQmCC'
    /** Notification icon size and corner radius, in pixels. */
    const ICON_SIZE = 128
    const ICON_RADIUS = 28

    /** Reminder copy, keyed by locale. */
    const DICT = {
      zh: {
        'row.title': '会话提醒',
        'row.description': '任意会话需要你交互，或真正停下来等你时，播放提示音并发送桌面通知；循环轮次与子代理完成默认静默。',
        'section.channels': '提醒方式',
        'section.scope': '提醒范围',
        'section.titles': '标题模板',
        'section.test': '测试与状态',
        'toggle.enabled': '提醒总开关',
        'toggle.sound': '提示音',
        'toggle.desktop': '桌面通知',
        'toggle.skipFocused': '正在查看该会话时不提醒',
        'toggle.skipFocusedHint': '窗口聚焦且该会话就在主视图时，连交互提醒也跳过。',
        'toggle.childCompletions': '子会话 / 子代理完成时也提醒',
        'toggle.childInteractions': '子会话 / 子代理需要交互时也提醒',
        'toggle.childInteractionsHint': '子代理卡在审批或提问时只有你能推动，所以默认提醒；它的完成默认静默。',
        'titles.hint': '用 {session} 插入会话名；留空使用当前语言的默认文案。',
        'template.question': '问题',
        'template.planReview': '计划评审',
        'template.approval': '审批',
        'template.done': '完成',
        'title.question': '需要你回答 · {session}',
        'title.planReview': '需要你确认计划 · {session}',
        'title.approval': '需要你批准 · {session}',
        'title.done': '会话已完成 · {session}',
        'body.done': '这一轮已经结束，点开查看结果。',
        'body.question': '有一个问题在等你回答。',
        'body.planReview': '有一份计划在等你确认。',
        'body.approval': '有一个工具调用在等你批准。',
        'body.test': '这是 session-notifier 的测试提醒。',
        'alert.subagent': '子代理',
        'action.reset': '恢复默认',
        'action.test': '测试：需要你介入',
        'action.testDone': '测试：会话已完成',
        'action.testDelay': '10 秒后测试',
        'action.allow': '允许桌面通知',
        'status.environment': '环境',
        'status.environment.electron': 'DSH 桌面应用',
        'status.environment.browser': '浏览器',
        'status.permission': '通知权限',
        'status.audio': '音频',
        'status.icon': '图标',
        'status.fired': '已提醒',
        'status.last': '最近一次',
        'status.none': '还没有',
        'status.saved': '设置自动保存在本浏览器，刷新后仍然有效。',
        'result.disabled': '提醒已关闭',
        'result.watching': '已跳过（正在查看该会话）',
        'result.desktop-off': '只响提示音（桌面通知已关闭）',
        'result.no-permission': '只响提示音（没有桌面通知权限）',
        'result.unsupported': '只响提示音（环境不支持桌面通知）',
        'result.failed': '发送桌面通知失败',
        'result.sent': '已发送桌面通知',
        'ctx.focused': '（发送时窗口聚焦）',
        'ctx.unfocused': '（发送时窗口失焦）',
        'ctx.hidden': '（发送时窗口不可见）',
        'ctx.unknown': '',
      },
      en: {
        'row.title': 'Session reminders',
        'row.description': 'Plays a sound and shows a desktop notification when a session asks a question, requests approval, or genuinely stops for you. Loop rounds and subagent completions stay quiet by default.',
        'section.channels': 'Channels',
        'section.scope': 'Scope',
        'section.titles': 'Title templates',
        'section.test': 'Test and status',
        'toggle.enabled': 'Reminders enabled',
        'toggle.sound': 'Sound',
        'toggle.desktop': 'Desktop notification',
        'toggle.skipFocused': 'Stay quiet for the session on screen',
        'toggle.skipFocusedHint': 'When the window is focused and that session is in the main view, even interaction alerts are skipped.',
        'toggle.childCompletions': 'Also remind when a subagent finishes',
        'toggle.childInteractions': 'Also remind when a subagent needs you',
        'toggle.childInteractionsHint': 'A blocked subagent can only be moved by you, so it notifies by default; its completion stays quiet.',
        'titles.hint': 'Use {session} for the session name; leave a field empty to use the default copy for the current language.',
        'template.question': 'Question',
        'template.planReview': 'Plan review',
        'template.approval': 'Approval',
        'template.done': 'Finished',
        'title.question': 'Your answer is needed · {session}',
        'title.planReview': 'Your plan review is needed · {session}',
        'title.approval': 'Your approval is needed · {session}',
        'title.done': 'Session finished · {session}',
        'body.done': 'That turn is done — open it to see the result.',
        'body.question': 'A question is waiting for your answer.',
        'body.planReview': 'A plan is waiting for your review.',
        'body.approval': 'A tool call is waiting for your approval.',
        'body.test': 'This is a session-notifier test alert.',
        'alert.subagent': 'Subagent',
        'action.reset': 'Restore defaults',
        'action.test': 'Test: you are needed',
        'action.testDone': 'Test: session finished',
        'action.testDelay': 'Test in 10s',
        'action.allow': 'Allow notifications',
        'status.environment': 'Environment',
        'status.environment.electron': 'DSH desktop app',
        'status.environment.browser': 'browser',
        'status.permission': 'permission',
        'status.audio': 'audio',
        'status.icon': 'icon',
        'status.fired': 'fired',
        'status.last': 'last',
        'status.none': 'none yet',
        'status.saved': 'Settings are saved in this browser and survive a refresh.',
        'result.disabled': 'reminders are off',
        'result.watching': 'skipped (that session is on screen)',
        'result.desktop-off': 'sound only (desktop notifications are off)',
        'result.no-permission': 'sound only (no notification permission)',
        'result.unsupported': 'sound only (this environment has no Notification API)',
        'result.failed': 'the desktop notification could not be created',
        'result.sent': 'desktop notification sent',
        'ctx.focused': ' (window focused)',
        'ctx.unfocused': ' (window unfocused)',
        'ctx.hidden': ' (window hidden)',
        'ctx.unknown': '',
      },
    }

    /** Notification icon once the rounded redraw settles; starts as the embedded original. */
    let notificationIcon = ICON_DATA_URL
    /** `pending` while the rounded redraw runs, then `ready` | `unavailable`. */
    let iconState = 'pending'

    // ---------------------------------------------------------------- utilities

    /** @returns whether the value is a non-null, non-array object. */
    function isRecord (value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** @returns the text shortened to at most `limit` characters. */
    function truncate (text, limit) {
      const collapsed = String(text).replace(/\s+/gu, ' ').trim()
      return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
    }

    /** @returns the first question's text when the interaction carries one. */
    function firstQuestionText (interaction) {
      const questions = interaction?.questions
      if (!Array.isArray(questions) || questions.length === 0) return undefined
      const first = questions[0]
      const text = typeof first === 'string'
        ? first
        : first?.question ?? first?.header ?? first?.title ?? first?.text
      return typeof text === 'string' && text.trim() !== '' ? truncate(text, DETAIL_LIMIT) : undefined
    }

    /** @returns the most human line the interaction itself can supply. */
    function interactionDetail (interaction) {
      const question = firstQuestionText(interaction)
      if (question !== undefined) return question
      const tool = typeof interaction?.toolName === 'string' ? interaction.toolName.trim() : ''
      const reason = typeof interaction?.displayReason === 'string'
        ? interaction.displayReason.trim()
        : typeof interaction?.reason === 'string'
          ? interaction.reason.trim()
          : ''
      const parts = [tool, reason].filter((part) => part !== '')
      return parts.length === 0 ? undefined : truncate(parts.join(' · '), DETAIL_LIMIT)
    }

    /** @returns whether the page is on screen and focused right now. */
    function userIsPresent () {
      if (typeof document === 'undefined') return false
      try {
        return document.visibilityState !== 'hidden' && document.hasFocus() === true
      } catch {
        return false
      }
    }

    /** @returns the window state a notification was created in. */
    function describeFocus () {
      if (typeof document === 'undefined') return 'unknown'
      try {
        if (document.visibilityState === 'hidden') return 'hidden'
        return document.hasFocus() === true ? 'focused' : 'unfocused'
      } catch {
        return 'unknown'
      }
    }

    /** @returns `electron` or `browser`, for the diagnostics line only. */
    function detectEnvironment () {
      try {
        if (typeof navigator !== 'undefined' && /Electron\//u.test(navigator.userAgent)) return 'electron'
        if (window.__DSH_HOST_PATHS__ !== undefined) return 'electron'
      } catch {
        /* fall through */
      }
      return 'browser'
    }

    /**
     * Render one title template. `{session}` becomes the session label; with no
     * label the placeholder and its dangling separator are removed, so a
     * session-less test reminder stays clean.
     * @param template - template string.
     * @param label - session label, or '' when unknown.
     * @returns the notification title.
     */
    function renderTitle (template, label) {
      const title = String(template).split('{session}').join(label).trim()
      if (label !== '') return title
      return title.replace(/[\s·:：|\-–—]+$/u, '').trim()
    }

    // ---------------------------------------------------------------- preferences

    /** @returns the parsed value at a storage key, or undefined. */
    function readStoredJson (storage, key) {
      try {
        const raw = storage.getItem(key)
        if (raw === null) return undefined
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }

    /** @returns a fresh defaults object. */
    function defaultSettings () {
      return { ...DEFAULT_SETTINGS, titles: {} }
    }

    /**
     * Read the options, migrating the keys owned by the two predecessor plugins.
     * A migrated profile is written to the current key so later writes have one
     * source of truth.
     * @param storage - the browser localStorage.
     * @returns the settings to start this page with.
     */
    function readStoredSettings (storage) {
      const base = defaultSettings()
      const current = readStoredJson(storage, SETTINGS_KEY)
      if (isRecord(current)) {
        for (const key of BOOLEAN_KEYS) {
          if (typeof current[key] === 'boolean') base[key] = current[key]
        }
        if (isRecord(current.titles)) {
          for (const key of TITLE_KEYS) {
            const value = current.titles[key]
            if (typeof value === 'string' && value.trim() !== '') base.titles[key] = value
          }
        }
        return base
      }

      let migrated = false

      // Desktop predecessor: sound / desktop / skipFocused.
      const desktop = readStoredJson(storage, LEGACY_DESKTOP_KEY)
      if (isRecord(desktop)) {
        migrated = true
        for (const key of ['sound', 'desktop', 'skipFocused']) {
          if (typeof desktop[key] === 'boolean') base[key] = desktop[key]
        }
      }

      // Server predecessor: master switch, toggles, title overrides, subagent policy.
      const server = readStoredJson(storage, LEGACY_SERVER_KEY)
      if (isRecord(server)) {
        migrated = true
        for (const key of ['enabled', 'sound', 'desktop']) {
          if (typeof server[key] === 'boolean') base[key] = server[key]
        }
        if (typeof server.subagents === 'boolean') {
          base.childCompletions = server.subagents
          base.childInteractions = server.subagents
        }
        if (server.onlyWhenAway === true) base.skipFocused = true
        if (isRecord(server.titles)) {
          for (const key of TITLE_KEYS) {
            const value = server.titles[key]
            if (typeof value === 'string' && value.trim() !== '') base.titles[key] = value
          }
        }
      }

      if (migrated) {
        try {
          storage.setItem(SETTINGS_KEY, JSON.stringify(base))
        } catch {
          /* the options stay in memory when storage refuses the write */
        }
      }
      return base
    }

    /**
     * Preference store shared by the notifier and its Settings page.
     * @param storage - the browser localStorage.
     * @returns the snapshot source, reader, patch writer and reset.
     */
    function createSettingsStore (storage) {
      let snapshot = readStoredSettings(storage)
      const listeners = new Set()

      const freeze = (value) => Object.freeze({ ...value, titles: { ...value.titles } })
      const persist = () => {
        try {
          storage.setItem(SETTINGS_KEY, JSON.stringify(snapshot))
        } catch {
          /* a failed write keeps the in-memory preference */
        }
      }
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* one broken subscriber must not stop the others */
          }
        }
      }

      return {
        source: {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        get: () => snapshot,
        /**
         * Apply one patch and persist it.
         * @param patch - boolean options and/or title overrides; empty title deletes the override.
         */
        update (patch) {
          if (!isRecord(patch)) return
          const next = { ...snapshot, titles: { ...snapshot.titles } }
          let changed = false
          for (const key of BOOLEAN_KEYS) {
            if (typeof patch[key] !== 'boolean' || patch[key] === snapshot[key]) continue
            next[key] = patch[key]
            changed = true
          }
          if (isRecord(patch.titles)) {
            for (const key of TITLE_KEYS) {
              if (!(key in patch.titles)) continue
              const value = patch.titles[key]
              if (typeof value === 'string' && value.trim() !== '') {
                if (next.titles[key] !== value) {
                  next.titles[key] = value
                  changed = true
                }
              } else if (key in next.titles) {
                delete next.titles[key]
                changed = true
              }
            }
          }
          if (!changed) return
          snapshot = freeze(next)
          persist()
          notify()
        },
        reset () {
          snapshot = freeze(defaultSettings())
          persist()
          notify()
        },
      }
    }

    // ---------------------------------------------------------------- diagnostics

    /**
     * Last-attempt record, so a silent environment is diagnosable from the
     * Settings page. `result` is one of the `result.*` locale keys.
     * @returns the snapshot source plus its writer.
     */
    function createDiagnostics () {
      let snapshot = Object.freeze({ at: 0, result: 'none', context: 'unknown' })
      const listeners = new Set()
      return {
        source: {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        record (result) {
          snapshot = Object.freeze({ at: Date.now(), result, context: describeFocus() })
          try {
            console.info(`[session-notifier] desktop notification: ${result} (${snapshot.context})`)
          } catch {
            /* logging is optional */
          }
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* one broken subscriber must not stop the others */
            }
          }
        },
      }
    }

    // ---------------------------------------------------------------- chime

    /**
     * Web Audio chime: two short tones per alert kind, no audio asset.
     * @returns the player plus the user-gesture unlock.
     */
    function createChime () {
      let audioContext = null
      let lastPlayedAt = 0

      function ensureContext () {
        if (audioContext !== null) return audioContext
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (typeof Ctor !== 'function') return null
        try {
          audioContext = new Ctor()
        } catch {
          audioContext = null
        }
        return audioContext
      }

      function tone (context, at, frequency, duration) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, at)
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.linearRampToValueAtTime(0.18, at + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(at)
        oscillator.stop(at + duration + 0.03)
      }

      return {
        /** @returns the audio context state for diagnostics; never creates one. */
        state () {
          if ((window.AudioContext ?? window.webkitAudioContext) === undefined) return 'unsupported'
          return audioContext === null ? 'not-created-yet' : audioContext.state
        },
        /** Resume a suspended context inside a user gesture. */
        unlock () {
          const context = ensureContext()
          if (context !== null && context.state === 'suspended') context.resume().catch(() => {})
        },
        /**
         * Play the alert pattern for one kind.
         * @param kind - `interaction` or `completion`.
         */
        play (kind) {
          const context = ensureContext()
          if (context === null) return
          const now = Date.now()
          if (now - lastPlayedAt < CHIME_COOLDOWN_MS) return
          lastPlayedAt = now
          const emit = () => {
            const at = context.currentTime + 0.01
            if (kind === 'interaction') {
              tone(context, at, 880, 0.16)
              tone(context, at + 0.19, 1174.66, 0.24)
            } else {
              tone(context, at, 659.25, 0.14)
              tone(context, at + 0.16, 987.77, 0.2)
            }
          }
          if (context.state === 'suspended') context.resume().then(emit, () => {})
          else emit()
        },
      }
    }

    // ---------------------------------------------------------------- desktop notification

    /** Windows caps a toast tag at 16 characters; this keeps tags unique inside that cap. */
    let notificationSeq = 0
    let tagAliasSeq = 0
    const tagAliases = new Map()
    /** The live notification per key, retired when that key alerts again. */
    const liveNotifications = new Map()

    /**
     * Build a Windows-safe toast tag: unique per alert, yet short.
     * @param key - stable identity of the alert source.
     * @returns a tag of at most 16 characters.
     */
    function toastTag (key) {
      let alias = tagAliases.get(key)
      if (alias === undefined) {
        tagAliasSeq += 1
        alias = tagAliasSeq.toString(36)
        tagAliases.set(key, alias)
      }
      notificationSeq += 1
      return `dsh${alias}-${notificationSeq.toString(36)}`.slice(0, 16)
    }

    /** @returns the current permission, normalized to granted/denied/default/unsupported. */
    function notificationPermission () {
      if (typeof Notification === 'undefined') return 'unsupported'
      const value = Notification.permission
      return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported'
    }

    /**
     * Ask for notification permission. Must be called from a user gesture.
     * @returns the permission after the request settles.
     */
    function requestNotificationPermission () {
      if (typeof Notification === 'undefined') return Promise.resolve('unsupported')
      if (Notification.permission === 'granted' || Notification.permission === 'denied') {
        return Promise.resolve(Notification.permission)
      }
      try {
        return Promise.resolve(Notification.requestPermission()).then(
          (value) => (value === 'granted' || value === 'denied' ? value : 'default'),
          () => notificationPermission(),
        )
      } catch {
        return Promise.resolve(notificationPermission())
      }
    }

    /**
     * Show one desktop notification.
     * @param key - stable identity used to retire the previous notification.
     * @param title - notification heading.
     * @param body - notification body.
     * @param onError - called when the system refuses to display it.
     * @returns `sent` | `unsupported` | `no-permission` | `failed`.
     */
    function showNotification (key, title, body, onError) {
      if (typeof Notification === 'undefined') return 'unsupported'
      if (Notification.permission !== 'granted') return 'no-permission'
      try {
        const previous = liveNotifications.get(key)
        if (previous !== undefined) {
          liveNotifications.delete(key)
          try {
            previous.onclose = null
            previous.close()
          } catch {
            /* an already-dismissed notification cannot be closed again */
          }
        }
        const notification = new Notification(title, {
          body,
          tag: toastTag(key),
          icon: notificationIcon,
          silent: true,
          requireInteraction: true,
          renotify: true,
        })
        liveNotifications.set(key, notification)
        notification.onclose = () => {
          if (liveNotifications.get(key) === notification) liveNotifications.delete(key)
        }
        notification.onerror = () => {
          try {
            console.warn('session-notifier: the system refused the desktop notification')
          } catch {
            /* logging is optional */
          }
          if (typeof onError === 'function') onError()
        }
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            /* focus refusal is harmless */
          }
          try {
            notification.close()
          } catch {
            /* ignore */
          }
        }
        return 'sent'
      } catch (error) {
        try {
          console.warn('session-notifier: desktop notification failed', error)
        } catch {
          /* logging is optional */
        }
        return 'failed'
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
    function roundedRectPath (context, x, y, width, height, radius) {
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
     * Redraw the embedded icon as a rounded 128×128 PNG. Runs at activation so
     * the icon is ready long before the first notification; `probe().icon`
     * reports the outcome. A failure keeps the original embedded icon.
     */
    async function resolveNotificationIcon () {
      try {
        const image = new Image()
        image.src = ICON_DATA_URL
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
        if (context === null) {
          iconState = 'unavailable'
          return
        }
        roundedRectPath(context, 0, 0, ICON_SIZE, ICON_SIZE, ICON_RADIUS)
        context.clip()
        context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE)
        notificationIcon = canvas.toDataURL('image/png')
        iconState = notificationIcon === ICON_DATA_URL ? 'unavailable' : 'ready'
      } catch {
        iconState = 'unavailable'
      }
    }

    // ---------------------------------------------------------------- session facts

    /** @returns the catalog row, or undefined when the Session is unknown. */
    function sessionRowOf (sessions, sessionId) {
      try {
        return sessions.list.getSnapshot().byId[sessionId]
      } catch {
        return undefined
      }
    }

    /** @returns whether the row marks a child (Subagent / teammate) Session. */
    function isChildSession (sessions, sessionId) {
      const row = sessionRowOf(sessions, sessionId)
      if (row === undefined) return false
      return row.origin === 'subagent' || row.parentId !== undefined
    }

    /** @returns the human label for one Session, prefixed for a child Session. */
    function sessionLabelOf (sessions, sessionId, t) {
      const row = sessionRowOf(sessions, sessionId)
      const label = typeof row?.displayTitle === 'string' && row.displayTitle !== ''
        ? row.displayTitle
        : typeof row?.title === 'string' && row.title !== ''
          ? row.title
          : String(sessionId)
      return row?.origin === 'subagent' || row?.parentId !== undefined
        ? `${t('alert.subagent')} ${label}`
        : label
    }

    /** @returns whether the Session list has finished its baseline. */
    function listReady (sessions) {
      try {
        const phase = sessions.list.getSnapshot().phase
        return phase === undefined || phase === 'ready'
      } catch {
        return true
      }
    }

    /** @returns the Session currently occupying the main view, if any. */
    function watchingSessionId (uiSession, sessions) {
      try {
        const value = uiSession.adapter?.current?.getSnapshot?.()
        if (value !== undefined && value !== null && value.key !== undefined) return value.key
      } catch {
        /* fall through to the retention projection */
      }
      try {
        const byId = sessions.list.getSnapshot().byId
        for (const id of Object.keys(byId)) {
          if ((byId[id].retainedBy?.mainView ?? 0) > 0) return id
        }
      } catch {
        /* no projection: treat nothing as watched */
      }
      return undefined
    }

    /** @returns the goal phase and round counter, when the catalog exposes a goal. */
    function goalOf (sessions, sessionId) {
      try {
        const goal = sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.goal
        const phase = goal?.goal?.phase
        if (typeof phase !== 'string') return undefined
        const rounds = typeof goal.roundsStarted === 'number' ? goal.roundsStarted : 0
        return { phase, rounds }
      } catch {
        return undefined
      }
    }

    /**
     * Diff two Session-status snapshots into the alerts the user must hear about.
     *
     * A request outranks a completion. A child Session's completion is dropped
     * unless enabled; its request is kept unless disabled. `becameUnread`
     * requires a Session we already tracked, so a row first seen already-unread
     * is replay, not news.
     * @param previous - status map before the update.
     * @param next - status map after the update.
     * @param sessions - Client Session catalog service.
     * @param settings - the live preferences.
     * @returns one entry per Session that newly needs the user.
     */
    function collectAlerts (previous, next, sessions, settings) {
      const alerts = []
      for (const [sessionId, state] of next) {
        const before = previous.get(sessionId)
        const interaction = state.pendingInteraction
        const child = isChildSession(sessions, sessionId)
        if (interaction !== undefined) {
          const beforeKey = before?.pendingInteraction?.key
          const changed = interaction.key === undefined
            ? interaction !== before?.pendingInteraction
            : interaction.key !== beforeKey
          if (changed && (!child || settings.childInteractions)) {
            alerts.push({ kind: 'interaction', sessionId, interaction })
          }
          continue
        }
        if (child && !settings.childCompletions) continue
        if (!listReady(sessions)) continue
        const finished = before?.running === true && state.running === false
        const becameUnread = before !== undefined && before.completionUnread !== true && state.completionUnread === true
        if (finished || becameUnread) alerts.push({ kind: 'completion', sessionId })
      }
      return alerts
    }

    /**
     * Hold completion alerts until the Session has provably stopped working.
     * A turn boundary is not the same event as "the AI is waiting for you":
     * goal rounds and queued follow-ups restart a Session by themselves.
     * @returns the candidate register plus the evaluator.
     */
    function createCompletionGate () {
      const waiting = new Map()

      return {
        /** Register one finished turn, remembering its goal round. */
        offer (sessionId, sessions, now) {
          const goal = goalOf(sessions, sessionId)
          waiting.set(sessionId, { since: now, rounds: goal?.rounds ?? 0 })
        },
        /**
         * Decide what each held candidate has become.
         * @returns alerts ready to be delivered now, and the next deadline.
         */
        evaluate (status, sessions, now) {
          const ready = []
          let deadline
          for (const [sessionId, candidate] of [...waiting]) {
            const state = status.get(sessionId)
            if (state === undefined || state.running === true || state.pendingInteraction !== undefined) {
              waiting.delete(sessionId)
              continue
            }
            const goal = goalOf(sessions, sessionId)
            const looping = goal?.phase === 'active'
            if (looping && goal.rounds > candidate.rounds) {
              waiting.delete(sessionId)
              continue
            }
            const due = candidate.since + (looping ? GOAL_QUIET_MS : COMPLETION_SETTLE_MS)
            if (now < due) {
              deadline = deadline === undefined ? due : Math.min(deadline, due)
              continue
            }
            waiting.delete(sessionId)
            ready.push({ kind: 'completion', sessionId })
          }
          return { ready, deadline }
        },
        clear: () => waiting.clear(),
      }
    }

    /**
     * Describe one alert through the catalog and the title templates.
     * @param alert - collected alert.
     * @param sessions - Client Session catalog service.
     * @param t - locale-bound translator.
     * @param settings - live preferences.
     * @returns the notification heading and body.
     */
    function describeAlert (alert, sessions, t, settings) {
      if (alert.test === true) {
        const title = renderTitle(settings.titles[alert.kind === 'completion' ? 'done' : 'question']
          ?? t(TITLE_DEFAULT_KEYS[alert.kind === 'completion' ? 'done' : 'question']), '')
        return { title, body: t('body.test') }
      }
      const label = sessionLabelOf(sessions, alert.sessionId, t)
      if (alert.kind === 'completion') {
        return {
          title: renderTitle(settings.titles.done ?? t(TITLE_DEFAULT_KEYS.done), label),
          body: t('body.done'),
        }
      }
      const domain = alert.interaction?.kind
      const titleKind = domain === 'approval'
        ? 'approval'
        : domain === 'plan-review'
          ? 'planReview'
          : 'question'
      const fallbackBody = titleKind === 'approval'
        ? t('body.approval')
        : titleKind === 'planReview'
          ? t('body.planReview')
          : t('body.question')
      return {
        title: renderTitle(settings.titles[titleKind] ?? t(TITLE_DEFAULT_KEYS[titleKind]), label),
        body: interactionDetail(alert.interaction) ?? fallbackBody,
      }
    }

    /**
     * Sound and notify for a batch of alerts.
     * @param alerts - alerts raised by one status update or one manual test.
     * @param deps - live preferences and services.
     */
    function dispatchAlerts (alerts, deps) {
      const { settings, chime, t, sessions, uiSession, diagnostics, stats } = deps
      if (!settings.enabled) {
        diagnostics.record('disabled')
        return
      }
      const watchId = settings.skipFocused ? watchingSessionId(uiSession, sessions) : undefined
      const observing = settings.skipFocused && userIsPresent() && watchId !== undefined
      const deliver = alerts.filter((alert) => !(observing && alert.sessionId === watchId))
      if (deliver.length === 0) {
        diagnostics.record('watching')
        return
      }
      const described = deliver.map((alert) => ({
        alert,
        ...describeAlert(alert, sessions, t, settings),
      }))
      const urgent = deliver.some((alert) => alert.kind === 'interaction')
      if (settings.sound) chime.play(urgent ? 'interaction' : 'completion')
      stats.fired += deliver.length
      const last = described[described.length - 1]
      stats.last = { kind: last.alert.kind, sessionId: last.alert.sessionId ?? null, title: last.title, body: last.body, at: Date.now() }
      if (!settings.desktop) {
        diagnostics.record('desktop-off')
        return
      }
      let outcome = 'sent'
      for (const item of described.slice(0, MAX_NOTIFICATIONS_PER_BATCH)) {
        const key = item.alert.sessionId === undefined ? 'test' : `session-${item.alert.sessionId}`
        const result = showNotification(key, item.title, item.body, () => {
          diagnostics.record('failed')
        })
        if (result !== 'sent') outcome = result
      }
      diagnostics.record(outcome)
    }

    // ---------------------------------------------------------------- Settings page

    const PAGE_STYLE = { display: 'flex', flexDirection: 'column', gap: '18px' }
    const SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '10px' }
    const HEADING_STYLE = { margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const HINT_STYLE = { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const INTRO_STYLE = { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const ROW_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }
    const LABEL_STYLE = { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
    const SUB_HINT_STYLE = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const BUTTON_STYLE = {
      height: '30px',
      padding: '0 12px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }
    const BUTTON_ACCENT_STYLE = { ...BUTTON_STYLE, border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' }
    const INPUT_STYLE = {
      height: '30px',
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
    }
    const SWITCH_TRACK_STYLE = {
      position: 'relative',
      display: 'inline-block',
      width: '28px',
      height: '16px',
      borderRadius: '999px',
      background: 'var(--dsw-alias-border-l2)',
      transition: 'background 120ms ease',
    }
    const SWITCH_THUMB_STYLE = {
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      background: 'var(--dsw-alias-bg-layer-1)',
      transition: 'transform 120ms ease',
    }

    /**
     * One host-styled switch. Implemented with native elements so the plugin does
     * not depend on a primitives export that an older embedded shell may lack.
     * @param props - label, current value, change callback.
     * @returns the switch button.
     */
    function Toggle ({ label, checked, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        onClick: () => {
          onChange(!checked)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          cursor: 'pointer',
        },
      }, [
        h('span', { key: 'track', style: { ...SWITCH_TRACK_STYLE, background: checked ? 'var(--dsw-alias-brand-primary)' : SWITCH_TRACK_STYLE.background } },
          h('span', { style: { ...SWITCH_THUMB_STYLE, transform: checked ? 'translateX(12px)' : 'translateX(0)' } })),
      ])
    }

    /** @returns a titled settings section. */
    function section (title, children) {
      return h('div', { style: SECTION_STYLE }, [
        h('h3', { key: 'heading', style: HEADING_STYLE }, title),
        ...children,
      ])
    }

    /** @returns one labeled switch row. */
    function toggleRow ({ label, hint, checked, onChange }) {
      return h('div', { style: ROW_STYLE }, [
        h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, [
          h('span', { key: 'label', style: LABEL_STYLE }, label),
          hint === undefined ? null : h('span', { key: 'hint', style: SUB_HINT_STYLE }, hint),
        ]),
        h(Toggle, { key: 'toggle', label, checked, onChange }),
      ])
    }

    /** @returns one title-template input row. */
    function templateField ({ labelKey, templateKey, value, placeholder, onChange, t }) {
      const label = t(labelKey)
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
        h('span', { key: 'label', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('input', {
          key: 'input',
          type: 'text',
          value,
          placeholder,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
          style: INPUT_STYLE,
        }),
      ])
    }

    /**
     * Settings → 会话提醒: live options, title templates, one-click reminders and
     * the facts behind a silent alert.
     * @param props - composed Settings slot props; `t` is bound to this namespace.
     * @returns the settings content.
     */
    function SessionNotifierSettings (props) {
      const api = props?.api
      const t = typeof props?.t === 'function' ? props.t : (key) => DICT.zh[key] ?? key
      const settings = useSettingsSource(api.settingsSource)
      const diagnostics = useSettingsSource(api.diagnosticsSource)
      const [facts, setFacts] = React.useState(() => api.probe())
      const update = (patch) => {
        api.setSettings(patch)
        setFacts(api.probe())
      }
      const fire = (kind) => {
        api.test(kind)
        setFacts(api.probe())
      }
      const delayTest = () => {
        api.testDelayed()
        setFacts(api.probe())
      }
      const status = diagnostics.result === 'none'
        ? t('status.none')
        : `${new Date(diagnostics.at).toLocaleTimeString()} ${t(`result.${diagnostics.result}`)}${t(`ctx.${diagnostics.context ?? 'unknown'}`)}`
      return h('div', { style: PAGE_STYLE }, [
        h('p', { key: 'intro', style: INTRO_STYLE }, t('row.description')),
        section(t('section.channels'), [
          toggleRow({ label: t('toggle.enabled'), checked: settings.enabled, onChange: (value) => update({ enabled: value }) }),
          toggleRow({ label: t('toggle.sound'), checked: settings.sound, onChange: (value) => update({ sound: value }) }),
          toggleRow({ label: t('toggle.desktop'), checked: settings.desktop, onChange: (value) => update({ desktop: value }) }),
        ]),
        section(t('section.scope'), [
          toggleRow({
            label: t('toggle.skipFocused'),
            hint: t('toggle.skipFocusedHint'),
            checked: settings.skipFocused,
            onChange: (value) => update({ skipFocused: value }),
          }),
          toggleRow({
            label: t('toggle.childCompletions'),
            checked: settings.childCompletions,
            onChange: (value) => update({ childCompletions: value }),
          }),
          toggleRow({
            label: t('toggle.childInteractions'),
            hint: t('toggle.childInteractionsHint'),
            checked: settings.childInteractions,
            onChange: (value) => update({ childInteractions: value }),
          }),
        ]),
        section(t('section.titles'), [
          h('p', { key: 'hint', style: HINT_STYLE }, t('titles.hint')),
          ...TITLE_KEYS.map((key) => templateField({
            labelKey: `template.${key}`,
            templateKey: key,
            value: settings.titles[key] ?? '',
            placeholder: t(TITLE_DEFAULT_KEYS[key]),
            onChange: (value) => update({ titles: { [key]: value } }),
            t,
          })),
          h('div', { key: 'reset', style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button',
              onClick: () => {
                api.resetSettings()
                setFacts(api.probe())
              },
              style: BUTTON_STYLE,
            }, t('action.reset'))),
        ]),
        section(t('section.test'), [
          h('div', { key: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
            h('button', {
              key: 'test',
              type: 'button',
              onClick: () => fire('interaction'),
              style: BUTTON_ACCENT_STYLE,
            }, t('action.test')),
            h('button', {
              key: 'test-done',
              type: 'button',
              onClick: () => fire('completion'),
              style: BUTTON_STYLE,
            }, t('action.testDone')),
            h('button', {
              key: 'test-delay',
              type: 'button',
              onClick: delayTest,
              style: BUTTON_STYLE,
            }, t('action.testDelay')),
            h('button', {
              key: 'allow',
              type: 'button',
              onClick: () => {
                api.requestPermission()
              },
              style: BUTTON_STYLE,
            }, t('action.allow')),
          ]),
          h('p', { key: 'status', style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
            `${t('status.permission')} ${facts.permission} · ${t('status.audio')} ${facts.audio} · ${t('status.icon')} ${facts.icon} · ${t('status.fired')} ${String(facts.fired)} · ${t('status.last')} ${status}`),
          h('p', { key: 'environment', style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
            `${t('status.environment')} ${t(facts.environment === 'electron' ? 'status.environment.electron' : 'status.environment.browser')} · ${t('status.saved')}`),
        ]),
      ])
    }

    /**
     * Subscribe a React component to one snapshot source.
     * @param source - getSnapshot/subscribe pair.
     * @returns the current snapshot.
     */
    function useSettingsSource (source) {
      const [value, setValue] = React.useState(() => source.getSnapshot())
      React.useEffect?.(() => source.subscribe(() => {
        setValue(source.getSnapshot())
      }), [source])
      return value
    }

    // ---------------------------------------------------------------- plugin

    /**
     * Install the notifier and its Settings page for this profile.
     * @param ctx - Client plugin context.
     */
    function apply (ctx) {
      /** Storage access itself can throw when the browser disables it; the store then stays in memory. */
      let storage
      try {
        storage = window.localStorage
      } catch {
        storage = undefined
      }
      const settings = createSettingsStore(storage)
      const diagnostics = createDiagnostics()
      const chime = createChime()
      const stats = { fired: 0, last: null }
      let primed = false

      ctx.effect(() => ctx.locale?.register?.(NS, DICT), 'session-notifier: dictionaries')
      const t = ctx.locale.bind(NS)

      const deps = (scope) => ({
        settings: settings.get(),
        chime,
        t,
        sessions: scope?.sessions ?? currentScope?.sessions,
        uiSession: scope?.uiSession ?? currentScope?.uiSession,
        diagnostics,
        stats,
      })

      /** Scope captured once the service injection runs; dispatch before it only serves manual tests. */
      let currentScope

      // Resolve the rounded icon once. The embedded icon is used until it settles.
      void resolveNotificationIcon()

      // The Settings page is a convenience: a rejected registration must not
      // cost the notifier. `slots.inject` waits for a declaration, so a host
      // that lacks one of these slots simply renders nothing for it.
      const settingsPageProps = () => ({
        inject: () => ({
          api: {
            getSettings: () => settings.get(),
            setSettings: (patch) => {
              settings.update(patch)
            },
            resetSettings: () => {
              settings.reset()
            },
            settingsSource: settings.source,
            diagnosticsSource: diagnostics.source,
            probe: () => buildProbe(),
            test: (kind) => fireTest(kind),
            testDelayed: () => {
              window.setTimeout(() => {
                fireTest('interaction')
              }, 10000)
            },
            requestPermission: () => {
              void requestNotificationPermission()
            },
          },
        }),
      })

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'session-notifier',
        order: 90,
        label: () => t('row.title'),
        locale: NS,
        ...settingsPageProps(),
      }, SessionNotifierSettings)), 'session-notifier: settings section')

      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'session-notifier',
        order: 50,
        label: () => t('row.title'),
        locale: NS,
        ...settingsPageProps(),
      }, SessionNotifierSettings)), 'session-notifier: settings plugin tab')

      // Audio and notification permission both need a user gesture; the first
      // one unlocks the chime and, when desktop notifications are on, asks for
      // permission exactly once.
      let askedPermission = false
      const onGesture = () => {
        chime.unlock()
        if (askedPermission || !settings.get().desktop) return
        askedPermission = true
        void requestNotificationPermission()
      }
      ctx.effect(() => {
        window.addEventListener('pointerdown', onGesture, { capture: true })
        window.addEventListener('keydown', onGesture, { capture: true })
        return () => {
          window.removeEventListener('pointerdown', onGesture, { capture: true })
          window.removeEventListener('keydown', onGesture, { capture: true })
        }
      }, 'session-notifier: first gesture unlock')

      /** Fire one manual test alert through the ordinary delivery pipeline. */
      const fireTest = (kind) => {
        const alert = { kind: kind === 'completion' ? 'completion' : 'interaction', sessionId: undefined, test: true }
        dispatchAlerts([alert], deps())
      }

      /** @returns everything needed to explain a silent alert. */
      const buildProbe = () => ({
        loaded: true,
        ...settings.get(),
        titles: { ...settings.get().titles },
        primed,
        fired: stats.fired,
        last: stats.last,
        audio: chime.state(),
        audioSupported: (window.AudioContext ?? window.webkitAudioContext) !== undefined,
        icon: iconState,
        iconUrl: notificationIcon === ICON_DATA_URL ? 'embedded' : `${String(notificationIcon).slice(0, 32)}…`,
        environment: detectEnvironment(),
        permission: notificationPermission(),
        visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
        focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        diagnostics: diagnostics.source.getSnapshot(),
      })

      /** Service face and console hook: read the options, drive a manual test. */
      const api = {
        isEnabled: () => settings.get().enabled,
        setEnabled: (value) => {
          settings.update({ enabled: value !== false })
        },
        isSoundEnabled: () => settings.get().sound,
        setSound: (value) => {
          settings.update({ sound: value !== false })
        },
        isDesktopEnabled: () => settings.get().desktop,
        setDesktop: (value) => {
          settings.update({ desktop: value !== false })
        },
        isSkipFocused: () => settings.get().skipFocused,
        setSkipFocused: (value) => {
          settings.update({ skipFocused: value === true })
        },
        areChildCompletionsEnabled: () => settings.get().childCompletions,
        setChildCompletions: (value) => {
          settings.update({ childCompletions: value === true })
        },
        areChildInteractionsEnabled: () => settings.get().childInteractions,
        setChildInteractions: (value) => {
          settings.update({ childInteractions: value === true })
        },
        getSettings: () => settings.get(),
        setSettings: (patch) => {
          settings.update(patch)
          return settings.get()
        },
        resetSettings: () => {
          settings.reset()
          return settings.get()
        },
        setTitleTemplate: (kind, value) => {
          if (!TITLE_KEYS.includes(kind)) return settings.get()
          settings.update({ titles: { [kind]: value } })
          return settings.get()
        },
        notificationPermission: () => notificationPermission(),
        requestPermission: () => requestNotificationPermission(),
        test: (kind) => fireTest(kind === 'completion' || kind === 'done' ? 'completion' : 'interaction'),
        testDelayed: () => {
          window.setTimeout(() => {
            fireTest('interaction')
          }, 10000)
        },
        probe: buildProbe,
        describe: () => ({
          ...settings.get(),
          titles: { ...settings.get().titles },
          fired: stats.fired,
          last: stats.last,
        }),
      }

      ctx.effect(() => {
        window.__dshSessionNotifier = api
        // The previous plugin's hook name stays available for existing console habits.
        window.__dshReminder = api
        try {
          ctx.reflect.provide('sessionNotifier', api)
        } catch (error) {
          console.warn(`session-notifier: service face unavailable: ${String(error)}`)
        }
        return () => {
          if (window.__dshSessionNotifier === api) delete window.__dshSessionNotifier
          if (window.__dshReminder === api) delete window.__dshReminder
        }
      }, 'session-notifier: service face and console hook')

      ctx.inject(['uiSession', 'sessions'], (scope) => {
        currentScope = { uiSession: scope.uiSession, sessions: scope.sessions }
        scope.effect(() => {
          const status = scope.uiSession.sessionStatus
          const gate = createCompletionGate()
          const scopeDeps = () => deps(scope)
          let previous = status.getSnapshot()
          let timer

          const disarm = () => {
            if (timer === undefined) return
            clearTimeout(timer)
            timer = undefined
          }

          const flush = () => {
            disarm()
            const now = Date.now()
            const { ready, deadline } = gate.evaluate(status.getSnapshot(), scope.sessions, now)
            if (deadline !== undefined) {
              timer = setTimeout(() => {
                timer = undefined
                flush()
              }, Math.max(0, deadline - now))
            }
            if (ready.length > 0) dispatchAlerts(ready, scopeDeps())
          }

          const onStatus = () => {
            const next = status.getSnapshot()
            const alerts = collectAlerts(previous, next, scope.sessions, settings.get())
            previous = next
            primed = true
            const immediate = alerts.filter((alert) => alert.kind === 'interaction')
            if (immediate.length > 0) dispatchAlerts(immediate, scopeDeps())
            const now = Date.now()
            for (const alert of alerts) {
              if (alert.kind === 'completion') gate.offer(alert.sessionId, scope.sessions, now)
            }
            flush()
          }

          const offStatus = status.subscribe(onStatus)
          // A goal appearing, finishing, pausing or advancing changes what
          // "quiet" means without touching the running flag.
          const offCatalog = scope.sessions.list.subscribe?.(flush)

          return () => {
            disarm()
            gate.clear()
            offStatus()
            if (typeof offCatalog === 'function') offCatalog()
          }
        }, 'session-notifier: Session status')
      })
    }

    return { name: 'session-notifier', inject: ['sessions', 'uiSession', 'locale', 'slots'], apply }
  },
})
