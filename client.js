/**
 * Session notifier — sound and desktop notification whenever any Session needs the user.
 *
 * Where the signal comes from
 * ---------------------------
 * `ctx.uiSession.sessionStatus` is the Client-side root projection that already merges, for every
 * Session the page knows, the three facts this plugin needs:
 *
 *   - `pendingInteraction`: the effective business interaction awaiting the user in that Session —
 *     a tool approval (`@deepseek-ai/dsh-client-ui-approval`), a user question, or a plan review
 *     (`@deepseek-ai/dsh-client-ui-user-questions`);
 *   - `running`: the Host-reported Agent running state for the Session;
 *   - `completionUnread`: a turn finished while that Session was not the one on screen.
 *
 * The plugin diffs successive snapshots of that projection: a new `pendingInteraction` raises an
 * interaction alert, and a `running` true→false transition (or a new `completionUnread`) raises a
 * completion alert. Nothing is subscribed per Session, so a Session the user never opened still
 * notifies. Completion alerts skip Subagent Sessions (`origin: 'subagent'`) — the main Session that
 * delegated to them is still running and reports the outcome itself — while their interaction
 * alerts are kept.
 *
 * How the user is alerted
 * -----------------------
 * - A Web Audio chime, so no audio asset has to ship. Browsers keep an AudioContext suspended
 *   until a user gesture, so the context is created and resumed on the first pointer or key press.
 * - A desktop notification through the page's `Notification` API. Permission is requested once on
 *   the first user gesture, and again from the Settings row's own buttons.
 *
 * Alerts stay quiet for the Session the user is already looking at, while the window has focus.
 * Everything is switchable in Settings → General, and the choice is kept in localStorage.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-notifier',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'session-notifier'
    /** localStorage key holding the three user preferences. */
    const SETTINGS_KEY = 'dsh.session-notifier.v1'
    /** Preference shape and the values a fresh install starts from. */
    const DEFAULT_SETTINGS = Object.freeze({ sound: true, desktop: true, skipFocused: true })
    /** At most this many desktop notifications per status batch. */
    const MAX_NOTIFICATIONS_PER_BATCH = 4
    /** Minimum gap between two chimes, so a burst of completions cannot become a siren. */
    const CHIME_COOLDOWN_MS = 900
    /** Notification-body length cap. */
    const DETAIL_LIMIT = 160
    /**
     * The DeepSeek Harness application icon (`resources/icon.png`, 96×96), embedded so the toast is
     * recognizable and independent of any page asset route. Windows toasts draw it at 48px.
     */
    const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAk2ElEQVR42u19eZwU5Zn/9z2q+pjunhlOOURAARVU5PCMwOhuYhJdNcJgPGKiBPEggooH6nbIupq4McFgjJAYTXYxccjvp/FIomjwBhEUhVFBo3KjwzBHT3dXV9X7vvtHHV3d03MPo0m2PhTT09Ndx3M/3+d53iLonY0opfDPtBFCAODzu2mlFFVK8TVr1nAABP98G1mzZg1XSvGamhrW3YPwbpyUvfDCC5IQIgFI7w/r1q1LVFRU6P8MlG9sbDRPOumkVFVVle29l0wm6YwZM2hVVZXoimZ0WnJrampYbW2tWrJkiQSAVCp1rKZpZ1BKTyGEjAUwUCoVzqtIt3Wrc19X3Tlqr5kfA4TUEaW2KYLXMrnc8/3i8Xc8RowfP55UV1eLXjvf8uXLNe+XXC43y7btv9q2bas2NhncZU92qURHu+jabvfCLovuN2datmmaazKZXLUn1C7NSI80QClFXnjhBVZVVWU3NTWdVFZWdjdj7DQAsG0bSinbPQYpPpbqFfH7QmuD8nZCCA/pjoyatv2KkTEXlZeXrVuzZg2fMWOGIISoLjMgqEqGYdzAOb+LMcYtyxKuGtIOGdhrd94JRnyOJskVVgEA4ZDObCHsnGkujkWj/1VsujvlhAMOxTYM4xehUGieZVlKSikIIayrDkYF3+jWnRP3fwXV6ZN18dp67hcYABg5UxACVhaJ3J3JGKOj0fCVbqSIUkwoJcFkw4YNfMqUKZZHfNu2LaUUJ27w230Z/qfRBkUIsUO6pqWzuQdi0fCVGzZs0KZMmWIXn44Wf3n58uV8ypQpViaTucGVfAuA1hPio5STID07EunSybp4bT3XBgJAy5mWVRYJzWtoalo0ZcoUa/ny5bxdDVizZg2vqqqy6+rqplZWVq5VSkEpRXtK/A6l7h80ZFVKKUqJpISirrHh5KEDB77h0biUBpC6ujpVU1PDEonEMsYYU0rhYBAfB0EbSK9kOz28nBKaIKUC54xVxOLLampqWF1dnQqewn/h2iirubl5ZjweX2VZVpcc7v9pQ/sRUjiks/rGxlkDKiv/sHz5Bu2KK6ZYQQ0gH330kQRAdF1f0NcgE+kVg/zF1gYAKqyHFwAglZUOrX0G1NTU0OrqarFjx44JnPOTbNtGX0n/wXHS+EI5aUIIMy0Lus5P2rFjx4Tq6mpRU1NDfQaMHj2aAkC/fv2+4tp+gc9p+0fVBimV0Dhn5ZWVXw7SnAIgGzduBAAwxk7xIIjPFef9BwxZvVhGY/wUAHBpTnwcZ9asWWTlypWbNE2bYFmWdKGGz337R0nglFIyHNJp1jC2RCORiR6ORJPJJAEgL7zwwjiAgb3ve/5PG/yqIQBC6IDHHnssDkAmk8m8lA8aNEgH8IUtqPSOb0DnfQPpfd8gpQKAkEvr0lDEF3nrU21A3/iGvysGlLzZL6A2kH90BvQWnCGE8MxCr2pDVz7O/16J7wKFcLphnDoBIQS0E8GbUgpSSoTDIQBALmeCUtJxjeAg1Bz43xPBHUcmIaUCpQScczCWT9iFlHCz+DYtvEf8UEjH6udeRDwRwwlTjodpWqCUgRCn8NMhI1TXtEF9kRjgEdOTYue1d8vEyU4CPz2iUUoQCoV8RtTXH8D++gNIpzNgjGLo0CHo168SUimQNsRPSglN0/DxJztw25IfYvSoEXjwgaVgjEEpiXylVbVP525oA/k8GeARW0qnKkcpBecclNJ2bbQQAprmfM62bWypfQ+vrX0Db256G9u370JLOu1l8WCM4QfJm3HKSVNhmiYoYwXi55xfgTGKx/74Z9iWhT179mHbhx/h2AlHIZczHe0hpKAM2llt8O6xvXsifc0Aj+hKKei67l9cNptF3f56NDQ0ojmVgpE1IKQEZwzRaASJRAL9KisQj8exd9+neOnltVj93BrUvrcV6XQGuq4hEgkjpIfAXFM05zsXYcL4I2FZFiiledoEpJUxilQqjfUbNkLTdbS0pPHEk3/BxGPHQykF2xZgjIFSUkDh9rRBEQUpJDjj4Jwjl8sFGPk5OWFPGoSQiEScfq1du/Zg3foN2LDhTWz78G+oq9uPlnQGlmVBCuljJowx6LqGeCKOfpUV2PdpHT77rA6a5hC9PBEHCHGYSYBMJoMF8+fhgupvwDCMAuwlSDipJHRNw/Ydu7Bn7z4ACqFIGE88/QwGDx6Iy799ITjnMIwchHC0tD1t8MynbQuEwyEcaGhEfX0Djhg90vVFHcdD/GARXwgBzjl0Xcc7m7fgd4/+P7z08quoq6t3QCmNg3MNlFGEQnphYqScrPHAgQP47LM6cK6hvLzcNyGWskEJAdE0GIaBEcOH48wvVyGTyYAx1krygkyglOJAQwOyWQOccwjbBmMM9y9/COvWb8Tsmeeiavqp0DQNuVzOd/KEECgFKOVos/LvUyIWi6Kurh633H4ntu/cjfvvvQuHjxoJ07TAWB8zwFFjG5FIBPv312PZz5fj8SeeRiaTQTQaRSIRh3IJrJSEkgpCCV++gopPCUNI51BQsG2r4K+KAFII2EKAu8xUysMX27C9LhdM04QUAooxSCEAQhCJhPHW25vx5lvvYMqk43DLjdfi8NEjYRg5x/8IAUYpdE0HoYXn+PCjT/D9O36M7dt3gnGO3Xv2YewRo9trojk4DJBSQQiH+OtefwO3J+/ARx9/gkQigXgiASkEnCYLBCKfIIWIf8mk2G25FPRMgsNEAY1zfPDhR1i/4U2cUTUN6XQamqYVmKHiQ+m65pivQDRm2zZCug7GON7YuAlXL7gZy+/7MYYOOQS2bSMajSCXs/C3j7djf/0BKKVgWRY2vb0FTzz9LFoyGZQn4pBSol9lBaSUeaxZ9QEDHHV0iP/4E0/j9uR/QAiJiooKp41RiBLEDfzmhaGtGOHqhfdDKbcpm0IR4jv4u+5eCo1zTDvtFJimCSEkGKMFTCBuGFpRUY5wOATTtAoEwYu64rEy7NixG0uXrcDSH/8HLNvG72sexxNPP4NPtu9EJpN1rwWQQiKRiKEsEoZpWqioKEf//pWwhcifux0m8N42O489/iRuvjWJcDgMzjksywrE+F7UEEyTVCFLlA/cFqD4jgK47xEASkJKCkUcQjccaMS11y/GhRecj2uunINQKIRczgTneZ9ACIFt2xg0cAAGDOiPHTv3gDMKoiSkc0gQQpAzTUSjYbyx4S2sXbcBD//Po3j+ry85UVcoBK8PlDLmhNKuqAvbwvBhh6B/v0o3mqIdJgK0N4n/8iuv4bbkDxAOhUEJhbAFlCoYI/Btj1IFLCkUEeWJpSpdTpHOlx2HKCGEAKUEuq7jod8+givn34A9e/YhEgl7TcRwW2wghEBlRQXGHz0Otm2BMhagjfIdvVKAaZm47sZ/x8uvrEO/fv0QDkecACHghJWSAHHCWyEEJh4zHpFwGG1ODJHeZIAb42uahl27dmPx7UugAFDq3GhhBqNa15NUsZtSJUpOpZiQx4H8cFcKCNtGeSKBN996B9+9aiFq330fkUgElm23Kg2eMWMaOHfjfUJaMcHLCYxcDtFoBLZt+0kk3EybMQpKKJjrT8oTcXzplBNh2zYYJZ0C5GiP+7OVAiEUd/3oHuzduxeRUARCSjcCUAVxdElD2EVtKHilFJTME0wqCdM0EY1Gse/TT3HNtTdi45tvIxqJwLJsP0vN5XI4+eSpmDzxOGSzWXCNuybCY0T+LJRS36ESokAoAXWzbkoIKKPQdR2ZTBbTTjsZRxw+KoArdcwE2lPTEw6H8ac/P4NnVz+H8kQCtrDzWaCDbIESJ8p33i8VKSrvX/e0QRYywrJyCGk6mlMtWHjDrdjw5iZXivPhrq5puGreZYiEwlBSglHm/IUENMKNvCglDrEpBWMUnDEwykAZg65pME0TQ4YOxsUXzIRt2wEoouPujB4xgDGGVEsLfvXgw9A13dEGOOpJKfF34r0mtIgRQdRSdU4bSv7V/d9jAgDLNsE5RzqTwfU33o63Nm12mWCBMYZcLoeJx03A9QuuQiZrBDAc9/iEOkQnAIUj6ZwzcM7AOAXXGMKhEGzbyUOuv/ZKHHLIINcf0aIQuO1eJdr9kFNC13WsXv1XvPf+VkTLolAKoITmd+ruhIJQkmeMi9sTAhCKItykA99QwkE7oqq8H77Pt10mtLSkcd2iW/HO5lpEo1HYlgXOOTKZDM479+tYfOO1sCwLOcN0MmwCEOqExIRQMM6gMQZOGTTGEQrp0DUN6Uwa5eVxJG9dhKmTJrqZM+9SGbTbGkApgWVZ+OOTTzs2FI5TYtwBpDRNg8adnWuaCzswEFc6qLsHzVIBI/xiS9vaQFwfQ0DypqPI3QjbgqZxNDWnsOD6xT4TLJ8JWVTPPBdLf3wHDjlkkGNCCAFRboGHUTDGHOhEc7LybDoL07Iw/bRTcM+PluDEqZNg5HLgXPPvo7O1Mt69jNeR/tp330Nt7buIRqIAIY6KMhaIUAKEpU72KoSEkAJKqDyuQoqyYh/oUlDK8SOl8wbiMCEQyRQnbwoKtuUwobGpCfMX3oy77/w+TjxhMjKZDCglaE6lMH3aqXjv/W34yb33o7KyElJIJ8JhDuCXzeUQjUQweNBATBh/FM44fRomHX8sCIibb3SG+B0kYqqV1LUNLxNC8MYbG5FqaUFlRSUAB4DLGTlEo1FEImFwxmHbNrJGFkbagFTKUWdNA9WowwxbONksJBTxzk8KGaGcVIwE0Lp8ckX98NF5Td3MUxUojrBtaBpHcyqF+Qtvwg0Lr0H1zHMhhIBl2zAMA5s2bQbnDEpKB21lFJBAvLwMc75zMUaNOgxDDxmMAQP6A4Qgl8uBUgZN545GEtKzQW0ViINRcMOt2+yUUnj7nc3gLnZuWRaGDxuGb35zNkYeNgKJRByapsGyLDQ0NGLXrt348G8fYeu2D/DJJzvQ2NTkgFshHQCDbQlIKaCgXEYQuHRoUxuC10eUYyooo27JkromyPaZKCwBjTEIIZD8wQ+xdt0bmDf32xg3dgx27tqNTZu3IByOOMEEJWCEQEiFRDyOr/xrFcLhMCzLdoo9lELjvE3T171JeZW3tAR5aQzeqFJObJxKteCT7duhaZqTvudyOOecs1E98zwYhlEQirEjKE46cSqklEhnMti5cxc2bHwLL738GrbU1iKXyyESiQCKwbJsSCkAopDHy4jPBKhCKIMQBeJGKZZlQVkK0WgEhpGDZdmIRqOO1goBuDA5oQTxWBR/+stqvPzKWpx33lkwjByamlMoi0adZNINoRmjMC0TqVQLOOcuY3gBvNGTQUReMtRW+UpSa0YoMM7R0LAP9fUHwDkDIP2kQwgB27adi3XDEssSkK5T0DjH2DFH4OijjsTM887B25u34I9PPI0XX34VhmEgGonAtimEbUP647UqwATXQQdUwcF4LIweNQpzLrsEgwcPQv2BBrzy6lr85dnnIaRTmxCWBUBBSgdOiMdjsG0bDz38CDhniEajTu3Zz18IpFKIhMMIh8O+UJWqdpFiJnRSG3irrNRr8fA0guQdm4fj65SisakZmUzWTcOd7zY3N/u1WQ9j8TZW5EOy2SwIJThh6mRMnTIJb216Bw//diVefW0ddF2HpuuOREO6UaXyYWh/oRIFKEVAGEU2k0H1rHPx1TP/1Q8UqqZ/CWdUTccP/vNu1Dc0QNd02JbpmjNA2A5iWV4eL8CLfIdOCIQtMGjgAMRiZRBClCz49GQsl7aGFgoZEdQIFSjDZTIZWLaV/w6A/fvrC6NeP8ws3Cml0DTNR0tN08Sk44/DT/7rTty++EYk4nFkjSz0kA5CKGg7WbRXfYuEI3j4t4/gxlv+HffdvwI7du6CaZo49ZQTsPSeOzFwQH+Ylgnqx+lu0iZVAOdRXvLuh8pCCBw6fCg0TUNnl+TpSuceLZXvdMQIAI50uhctpASlDHv37oNpmu1GA8XM8HIGy7IghMD555+D5fffiymTj0cqlYKmO2XLIBMKLhQOKkoJwb59n+G997fhoYf/BwuvX4zm5hZkszkcddQ43PWD2xEOhfwIzsvalJJFKYZynSpxmE8IRo06rFvtcZ1pKC7SgHz83iYj3Pc8VXSkSIJxht1796CxsQmc805JSylGZNIZjBhxKO79yd2onnkeWtItYJyDMhfGAPF9i4LywcBMNoNxY4/Ak4/9HnMuvxSbN2/B1m0fIBYrQ6q5BZMnH49rr77Cjf1pPowieTvhoTaUutEXFCKRCEaPGukwmZJebyimRS4gAPcWCVoAApBK+U5JuigkYwx1dXXYsXOn2+SkujQ94u2apkMIG5QS3HrLIlw5dw6y2QyoG+4SD9jzDWweEt+9ezfu+/kKvPTKa6iorEBFRbnfBZdOp3H++efgjKppSDWn3GK5CjDCzaydmAqMUtjCxuDBA3DoocNgWXanW0260phFS6DDgX7LPCN8fijHLsbjcYRDYTeRcpxXJpPF5s1bQAKlwq6O8RACp8rEGLKGgavnzcH3rrkSWSML5oaBQSDPK4pQStGcasG99/0C7723FZrGoWuab3I8qb/6yjlO9GOJVqGKchWCEoBSBtu0MXbM4aisqHDC124Sv73GLNoWANwWI0CcULM8kUB5Ig5h22587bT1rd+wEZZlty66d1EbmJvotKTTmHPZpfjuZZe6BXfdFScVwO6UbyIqyhMI6TqamprxzuZacM792m8mk8GYIw7H2V8/E+l02mnkVYHzwoFMCCU+KDfp+ONc5vWc+J1wwnlMXbXBCMDVgEQcgwcPgrCd2Fq4XQWbN9fi40+2Q9N1SOnG/90cavOipXQ6javmfRf/dtZXHces6fBTYteSKOmYIkvYsG0Luqbjvl/8Eq+v34BEIo5wOIxYWRk45xg79ogC7fSKMN45CaUQUqJfvwpMPO4YF+M/OAzgbQ6eeUxwY2IViBKklIhEohg1ehTWrlvnmxxKOQ7U1+PFF1/C2DGHu1gJzbs40j0mMMZg2TZuWnQdPv5kO2rf24qwrsNye4WcujOBcnv9hVuob2xowNXfux4XXzgbp5x8AoSUWL/+Tfzh//8RkUgYUooAgBYICBiDkTNx6jEn4NDhw2CaZiCxPEgMaAnA7C4U5CZjqiD1DzJi/PijQdwihlMct6FpGv7yzLOorp4JXdcdXIaRNqGNzjCBUQZb2IjHY7ht8Y244srvwXCZK6WEcqMxt1kCIICtBDRdg2XZWPbzFfjlg7+BUgpZw0A0EnWgZTfxIm7WSykF835SgjNOn16iuHIwTRAK4/684y00S4RQmKaFCePHo7Kiwi31Ob4hFArh/a3b8MILLyISDkEI4VaqCsG+Llkm1zEbhoEJ44/G1VfOhZE1wBkPVNi8Sm5hggUolJc7wKCu66goLy9APD0IhTDq1zNM08TYMYfjhKmT3OEN2jcMCIabpSMg5UulaVkYMWIEjjrySL8b2NMCRgl+97tHkWpJO+ZJBZjaDUZ4EqhpGtKZDGbNPA//csYMpNNp1zQUQsHSrTNABjNdB/YWQvj23wf0qBN2UremYdsC55z9NcTjcXdmgBw0LcgzoKWY2AHHW8wIAEpKhMNhzKiaDimFH1EIIaCHQnj7nc148qmnnTqsZUP5nRIoKsAXaldnoiMAWHDtNRg0aKCDzxDqO9E8BKMgA9qg3F5UP+nySqKuyaGUgmscRi6HCUePwxlnzIBhGAUTOH2gAapEFoyScASlDIZhYPq0aRgyZAgs23KyR6kgbAE9pOPBBx/Crt17oema06oii0ycKnL6ndAGxhgsy8KokYfhmqvmwjRNMK652I2b2BJScE/FEYZfi4bjX6inAW4ryaXfutCBpRUOqvS3YoBUrU1DKTjCs7umZWPYsGE48ytfRtYwwDh3oiQhwBnHrt178NOlP4PGnYRIutJYjDEVmyUhJGzbgbULTIZLCK+gfs6/nYUzv/IvSKfzoamXI5MiJgS1z/8MdWu+lELXNaRaUjj7a2fi1FNO6hPpbzsTRucYwShFzjTxjfO/gcGDBsG2hR8V2ZaFeKwMTz/9J/z3ykcQj5W5zVFtg31KOYN2msYRDocQDju9mLZXtgwwglIGKSUWLrjGhQryoSIp6OspdOYkkD44pseZVchkDRw1biy+e/mljlYx3q0ab8+dcIAYaIcRngSZpoWRh43E7NnVyGYz4DwP99qWhUgkgp/+9F6sfn4NyhMxmJbpzOaq1k5fCKfd/L33t+KqaxbgJ0uX4YMPPkQkEnZnxESgK8P5feiQIbhp0fV+S6SDF7m7at0GotyRIi/zZZTBtm3EYlHcvGihO7+g/OP0rQa0mQUHasVFAB1nDJlsBrNnz8axxxyTb/XzC+qO5C5efDteeXUdyhNxWJbp+ASvydU9l5QOqPfGhjfx1NN/xq9+/RtcfOkc/PBH96ChsclvtvVaBTlnyGQyqJoxDXPnfBuplhZnDs2TdEoCtQm0KiESSvwo6eZFC3HUUeOQc5Ouvtpoyc6bUowo4ag9OFcphbJoFAuvW4hwKORIkNua7RCVwDCyWHjdDVj93BoHQxJ2QY7gHU9KhcNHj0JFRQXiZTGYpolfPfQbXHzJZXjmmdWIRCIgvjYQB8LOZPDdy7+Dr3/tTDQ2NUPTdR9p9hMp1XroQymFxuYmzL96Hk6vmo50OuMU2oE+kf7WDJAlGIGOY3jKOLJZA5MmTcJVV1+FTDrjF7ABuBOEDDnDwHXXL8LDv1mJsrIYKGVOVU3JPKJqGJg48TiMG3sEGhrqnUQqHseuPXtw7fU3Ifn9O5DNZHxt8M2RELh98U04cepkNDU7TpkABaEmIXkImxACwzCw4NqrcdGF1W45te9XbmgHjm7fWaqiEhrXnBbA2bNnY/YFF6C5qRm6np+ncjTBSfH/8867cNPNi9HU1IxYLOYW8i0n+rFsaJqOyy/7DrjGIYSAaZngjCIaDmPl72pw6XfmYtPb7/gNt46EOzWKu394B46dMN5hgq8JqgDCJm4eo2nOSOm2Dz5ELBZzOjPcqUe/Fb1PNaATBZlgoqZUYX8OYwyGkcOCBdfia1//OpqamqHrIaeaReDfVDxWhscfewyXfOtSPPnUn8AYRzweQyQSRjgcAiEE0077EoYPGw4jm/VhDsu2kEjEsHXbB7js8ivxyO9rEI1GQNz5NMu2UFlZgXuX3o0pkyaisbEJmhYCZdztSYULM1OfGff/4pf49uXzcN2iW/Dc82vcYZOwDzAe7I3NmDGDvPjii+qSSy4vGzJ08DWU0oiD7ftNHwiOu5JAQ2xxY4YriFBKYdq0adi371Ns3rwZ0UiZm1HnhyoikQgaGhrwzF+exbrX12P//nrkcibSmQz27N6NX/7qQbz++npoReVNr/olpcSzq/+Kz+rqMHXqFCQScQCAYTg9RqefPh27du3Bltp33XEprSDr9fZoxJlm+ejjT/DXNS9h3esbIKXAyMMO80urveUPGGNESmns2bPnvl//+tfpGTNmkIC7b2nleL3GJ68SRhBoUymCq32VYtQZAVXAbbfdhvLyBB59tAbRaNQN+Sy/k0HXdeghYNOmt/D66+sRcmN/0zRhGIbfJOUjnU5XmD+SlEiU4feP/gFvbXoH37r4mzjtS6dg0KCBoJSiLBrFfT+7B79+6Lf475W/QyaTBdc1UK+OrQrR1nA8DMoZdu7ahTt/eA927tyFhddeU9Rk1gf1AAT7Y7rMCAKilJskCQhhY+HC6zBs2HA88MADMC3L7am33MTKgS6i0SiiUeL3impcg57QnTGnQM+lZ+vhAnwQAuXlcWzfvh3//v07MHTIEIwbewQOG3koKioqoGshRMsiGDpkCLZv3wEFoKUl47bEsDz8QAmkkhCmdDowCEE4FO4TH8BLZ8Fo1R+q/AnSACNI/vPE7XL23qSUAcQJP7/5zQswZswYLF26FFu3bkVZNArGNV8bPKDMmbtyV0cRXpNU6/GGfPGc+Ov+lJWVoTnVjLWvr8fadeudjj1K0NTYhBNPPAG/uP9naGxoxKuvrcXH23egvr4eLek0LNN0kVYdiXgcAwYOwOTjJ2LWzHP9HtC+YwCKCzKFRRSVb5vxm2U9/6ACPfvemxQUhGtoSadx/PET8bNlP8MjKx/B448/jlQqhWgkAuIO9MnAiBEC8HXQvhVUrvz6LXUjLYVwWIeuxUApR9bIQuMcF194Ab596cWIRqIghODUUx2cpyWdRktLGtlsFkophEMhxONxxBNxRMNh5FzGHOx8oERrYn5Ut1V/aFF5stgs+fPURUPXGteRy5mIhCO4+uqrcPrpVaipqcErr7yKllTKmThxZ2+lVCU6KvIRQLAAEyxZMrcruiWdBmUUxx93HL51yUWYOnUKzFwOtm2BEALLMkEIRSKeQEV5uS/hXsuklNIBFt2+pz5lgAokAsq92YL+0DbqxG37B/i/M86h3O7oMWPG4Lbbb8f7772P1c+txutr12HPnj3O/JY7YcMYDzh44tdISeDYUjnLxBimCQWgoqICU6ZMxlfP/DJOOulEhEMhZLOOJhB3+ZrghXvBQEH5k7FWnc99qAEo1AB3Yt3vAOkuI/IIGjSiu4mOhXFHjsP48Uej7qKL8G7tu3h70yZs27YV+/btQ3Mq5S6qkS/kOGbHHRnSdcTKytC/f3+MGDECx0wYj4kTj8OokSPB3ZVOcqbpED/QbEsCM2UASqzQ1bdbgAGxVgUZz6Yr7wIDjCCBNvGgo+6IEYrA7XKjsC0bZs5EIhHHtGnTMH36NGSzWRw40ID99fvRUH8AzakUcrkclJLgnCMajSIWi6E8kUBlZSUqKysQi8fBmYNq2rYFIYULJ5NCJA7u9ebt2ee+RLDPgD2Zz8wJONrMT6QUOd4iRrQ9P9A6YiLBNR78hVGcgWfKGKAUcjnDD38HDRqIIUOGuBOWeQJ6USj85c8cyMDMmbAIcaAOxos6qUm7AtXefRykLffZZ5+ZxS2LZBZmkaWfrtgUjZZNyGTSgcW7Cy+IBP4LtmCToowYrcaI2sioS8zft1qOEoXHy0dBNPB7YNI9wDC0dV1dvA/0fE0NqWkazeVyWy655JKJq1atchbvBoDly5ezVVglpJQfaA6WrwoJ0hYu1A5S2tle08KBAgencSfSGXOmLpm7FpvnnJ0pdZrHdVA4Jdl2PQMdtuD3qH2mgwf6uD8/WLVqlVi+fDnzwbjKykriAF72a+4SW6pkv5Bqp3Oig16ijpt+82EwCTwdkQQG4PzWdH82OFB278a5uyRQqscP9FEuqPhakObebL4AgPoDDc82N6fbeXhPCeK10znRPUa0XZUr1bXRvWN1LAToQLO78xgTIYQ4cODAM+5bwjdB1dXVMplM8snHHrnZNI11sVgM7T/GRLXRwtL2RE1x24lShRrUKeK1IZGFx+olIUARI9pc3aVzT1HinMO27XUjRoyoTSaTvLq6WhbUA4YOHUoAKMM07qWMdvIR5R13TrSnzqoEIwpsNLpzrI6EQLXfgt/ZQlTXzRJJp9P3ApBnn302KTUvQJPJJAWAOVd879XyivITUqlmQQhlXVoOvicRU/Hne/NYHUU5vXmsIunXNI2Zpvn6nXfe+SXAf6inLK6Iqb1795IlS5bYTanG+ZZlCsa47707u4RTjyImdNZZdr59ptW50YZNPwgRk/tQT7i2/3tLliyxPUtTqiSpVqxYYSeTSX3CuMPXNzU03VJZGWeEELur62i1HzGh21FLZxx1qfaZ3nDUpQQK7TDCvR6bc84Mw7hlyJAh65PJpH7FFVfYpWa6C6LxZLKGL1lSbe7Yvf+BQ4b0v2L//qYePM62q+rcusrWYTLX3ueLlw7tybE6+XnvcbaapmnZbHZ5NBqdV1NTo1dXV9vF6+7QUo1j7767SiSTSX3EsAHzPq1reKBf/3LNHUkV3VlZrmuOunWk0VcRE3pBG6VUwu1X0tLp9PJoNDovmUzqq1atEmgj/ywptrNmzaKVlZV0xYoV1o699YvKopE7NU3nqVSq0480P7iO+iA4/RLa2GpNiLa0y3ukeTjkPNLcMG6NxWJ3z507V2toaJCrVq2SpRYu6GBpp1k0mTyaLVmyxPzg410nV1ZW/igcjpwmpES6pQVKKTuIJ31ejCBFduFgMKKEqVEu3qsIJTwc0r11qV9paWm5sX///muTyaT+7rvviraI35nZewKAzJ8/X1u2bFkOAN31WePMMNfmCSWnxeMxJiVgWSZsf5HWrj/FqBThWhO5F2x0N5hQ6liUUvDAqug50xIEeNk0cw/E4/FVAOT8+fNDy5Yts0qZna4+7IcAwNy5c/nGjRuxceNGCwC2bP14Yr/KitMpoScrYCygBiqJsOru8HLRGs+lpLs14UlgBa0ixtGi9QpbEdP7CEFBjaa4CaCEJlBKDCi1XwHblLDXNjU1PT98+PBNADB9+nQ+btw4smLFCrszi9aQLg54k2QyyZ966inlMcKrK6xcuTKuaVqob8sZ0RLvZdp4vwuHKjpE1H3Le93U1JS76KKLUgD8EH3y5MnaWWedRZYsWRIMM1UvPx2rgBF0/PjxtLa21svsRF8/CBqf7yPMmEsD1NbWSpcGnSZ8Tx8GSEpETQT/RJtXUOnps17/F3qK/fVq4ThDAAAAAElFTkSuQmCC'

    const zh = {
      'row.title': '会话提醒',
      'row.description': '任意会话需要你交互（提问、审批、计划审阅）或本轮结束时，播放提示音并发送桌面通知。子代理自己的会话结束时不提醒。',
      'toggle.sound': '提示音',
      'toggle.desktop': '桌面通知',
      'toggle.skipFocused': '正在查看该会话时不提醒',
      'action.allow': '允许桌面通知',
      'action.test': '测试提醒',
      'action.testDelay': '10 秒后测试',
      'permission.granted': '通知权限：已授权',
      'permission.default': '通知权限：未授权',
      'permission.denied': '通知权限：已被浏览器拒绝，请在浏览器设置中允许',
      'permission.unsupported': '当前环境不支持桌面通知，仅提示音可用',
      'env.label': '运行环境',
      'env.electron': 'DSH 桌面应用窗口',
      'env.browser': '浏览器窗口',
      'env.api': '通知接口',
      'env.api.yes': '可用',
      'env.api.no': '不可用',
      'status.none': '尚无提醒记录',
      'status.last': '上次提醒：',
      'status.sent': '已发送桌面通知',
      'status.watching': '已跳过（正在查看该会话）',
      'status.desktop-off': '未发送（桌面通知开关已关闭）',
      'status.no-permission': '未发送（没有桌面通知权限）',
      'status.unsupported': '未发送（环境不支持桌面通知）',
      'status.failed': '未发送（创建桌面通知失败）',
      'status.ctx.focused': '（发送时窗口聚焦）',
      'status.ctx.unfocused': '（发送时窗口失焦）',
      'status.ctx.hidden': '（发送时窗口不可见）',
      'status.ctx.unknown': '',
      'alert.question': '需要你回答',
      'alert.approval': '需要你确认',
      'alert.planReview': '计划待审阅',
      'alert.completion': '本轮已完成',
      'alert.subagent': '子代理',
      'test.body': '测试提醒：提示音与桌面通知均已生效。',
    }

    const en = {
      'row.title': 'Session notifications',
      'row.description': 'Plays a sound and shows a desktop notification when any Session asks a question, requests approval, or finishes a turn. A Subagent finishing its own Session stays quiet.',
      'toggle.sound': 'Sound',
      'toggle.desktop': 'Desktop notification',
      'toggle.skipFocused': 'Stay quiet for the Session on screen',
      'action.allow': 'Allow notifications',
      'action.test': 'Test',
      'action.testDelay': 'Test in 10s',
      'permission.granted': 'Notification permission: granted',
      'permission.default': 'Notification permission: not granted yet',
      'permission.denied': 'Notification permission: blocked by the browser',
      'permission.unsupported': 'Desktop notifications are unavailable here; the sound still works',
      'env.label': 'Environment',
      'env.electron': 'DSH desktop window',
      'env.browser': 'browser window',
      'env.api': 'Notification API',
      'env.api.yes': 'available',
      'env.api.no': 'unavailable',
      'status.none': 'No alert attempted yet',
      'status.last': 'Last alert: ',
      'status.sent': 'desktop notification sent',
      'status.watching': 'skipped (that Session is on screen)',
      'status.desktop-off': 'not sent (desktop toggle is off)',
      'status.no-permission': 'not sent (no notification permission)',
      'status.unsupported': 'not sent (this environment has no Notification API)',
      'status.failed': 'not sent (creating the notification failed)',
      'status.ctx.focused': ' (window focused)',
      'status.ctx.unfocused': ' (window unfocused)',
      'status.ctx.hidden': ' (window hidden)',
      'status.ctx.unknown': '',
      'alert.question': 'Your answer is needed',
      'alert.approval': 'Your confirmation is needed',
      'alert.planReview': 'A plan is waiting for review',
      'alert.completion': 'Turn finished',
      'alert.subagent': 'Subagent',
      'test.body': 'Test alert: the chime and desktop notification both work.',
    }

    const PERMISSION_KEYS = {
      granted: 'permission.granted',
      default: 'permission.default',
      denied: 'permission.denied',
      unsupported: 'permission.unsupported',
    }

    // ---------------------------------------------------------------- utilities

    /** @returns the text shortened to at most `limit` characters. */
    function truncate (text, limit) {
      const collapsed = text.replace(/\s+/gu, ' ').trim()
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

    /**
     * Tell the Desktop application window from a plain browser, for the Settings row's diagnostics.
     * The Desktop shell exposes `__DSH_HOST_PATHS__` and reports Electron in its user agent.
     * @returns `electron` or `browser`.
     */
    function detectEnvironment () {
      try {
        if (typeof navigator !== 'undefined' && /Electron\//u.test(navigator.userAgent)) return 'electron'
        if (window.__DSH_HOST_PATHS__ !== undefined) return 'electron'
      } catch {
        /* fall through to browser */
      }
      return 'browser'
    }

    /**
     * The window state a notification was created in, recorded so a missing system banner can be
     * told apart from a plugin-side failure.
     * @returns `focused`, `unfocused`, `hidden`, or `unknown`.
     */
    function describeFocus () {
      if (typeof document === 'undefined') return 'unknown'
      try {
        if (document.visibilityState === 'hidden') return 'hidden'
        return document.hasFocus() === true ? 'focused' : 'unfocused'
      } catch {
        return 'unknown'
      }
    }

    /**
     * @returns whether the Session is a Subagent's own Session.
     *
     * The Client Session catalog marks every Subagent conversation with `origin: 'subagent'`, whether
     * the row comes from the durable Session summaries or from a parent's `subagentCatalog`
     * projection. Nothing is inferred from the title or the parent link, so a Session the desktop
     * merely forked from a Subagent keeps notifying.
     */
    function isSubagentSession (sessionId, sessions) {
      try {
        return sessions.list.getSnapshot().byId[sessionId]?.origin === 'subagent'
      } catch {
        return false
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

    // ---------------------------------------------------------------- preferences

    /** @returns the stored preferences with every unknown or malformed field dropped. */
    function readStoredSettings () {
      const state = { ...DEFAULT_SETTINGS }
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (typeof parsed === 'object' && parsed !== null) {
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
              if (typeof parsed[key] === 'boolean') state[key] = parsed[key]
            }
          }
        }
      } catch {
        /* unreadable storage keeps the defaults */
      }
      return Object.freeze(state)
    }

    /**
     * Preference store shared by the notifier and its Settings row.
     * @returns the snapshot source plus a patch writer.
     */
    function createSettingsStore () {
      let snapshot = readStoredSettings()
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
        get: () => snapshot,
        update (patch) {
          const next = { ...snapshot }
          let changed = false
          for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (typeof patch[key] !== 'boolean' || patch[key] === snapshot[key]) continue
            next[key] = patch[key]
            changed = true
          }
          if (!changed) return
          snapshot = Object.freeze(next)
          try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot))
          } catch {
            /* a failed write keeps the in-memory preference */
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

    // ---------------------------------------------------------------- diagnostics

    /**
     * Last-attempt record, so a silent environment is diagnosable from the Settings row instead of
     * guessing. `result` is one of the `status.*` locale keys.
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
        /** Resume a suspended context inside a user gesture. */
        unlock () {
          const context = ensureContext()
          if (context !== null && context.state === 'suspended') context.resume().catch(() => {})
        },
        /**
         * Play the alert pattern for one kind.
         * @param kind - `interaction` (a request is waiting) or `completion` (a turn ended).
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

    /** Windows caps a toast tag at 16 characters; this suffix keeps tags unique inside that cap. */
    let notificationSeq = 0
    /** Short per-key alias, because a Session id is far longer than the tag limit. */
    let tagAliasSeq = 0
    const tagAliases = new Map()
    /** The live notification per key, retired when that key alerts again. */
    const liveNotifications = new Map()

    /**
     * Build a Windows-safe toast tag: unique per alert, yet short.
     *
     * A full Session id cannot be used — `ToastNotification.Tag` is capped at 16 characters, and a
     * tag past that limit makes Windows refuse the toast, which is invisible to the renderer. Each
     * key therefore gets a base-36 alias and the suffix is base-36 too, so the tag stays unique
     * without growing past the cap.
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

    /** @returns the current permission, normalized to `granted`/`denied`/`default`/`unsupported`. */
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
     *
     * Every alert gets a unique, short tag (see {@link toastTag}), and the previous notification of
     * the same key is closed first so the Action Center keeps one entry per Session. Two Windows
     * rules drive this: a toast whose tag+group already exists is replaced *silently* without a
     * banner, and a tag longer than 16 characters makes Windows refuse the toast entirely.
     * `requireInteraction` keeps the banner on screen instead of letting a "short" toast vanish
     * after a few seconds.
     * @param key - stable identity used only to retire the previous notification.
     * @param title - alert heading.
     * @param body - Session name and detail.
     * @param onError - called when the system refuses to display the notification.
     * @returns the outcome, one of `sent`/`unsupported`/`no-permission`/`failed`.
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
          icon: ICON_DATA_URL,
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

    // ---------------------------------------------------------------- alert decision

    /**
     * Diff two Session-status snapshots into the alerts the user must hear about.
     *
     * A Subagent finishing is not news: the main Session that delegated to it is still running and
     * will report the outcome itself, so its completion is dropped here. A Subagent that *stops to
     * ask* is still surfaced, because nothing else can move that Session and the parent may be
     * waiting on it.
     * @param previous - status map before the update.
     * @param next - status map after the update.
     * @param sessions - Client Session catalog service, used to recognize Subagent Sessions.
     * @returns one entry per Session that newly needs the user.
     */
    function collectAlerts (previous, next, sessions) {
      const alerts = []
      for (const [sessionId, state] of next) {
        const before = previous.get(sessionId)
        const interaction = state.pendingInteraction
        if (interaction !== undefined && interaction !== before?.pendingInteraction) {
          alerts.push({ kind: 'interaction', sessionId, interaction })
          continue
        }
        if (interaction !== undefined) continue
        if (isSubagentSession(sessionId, sessions)) continue
        const finished = before?.running === true && state.running === false
        const becameUnread = before?.completionUnread !== true && state.completionUnread === true
        if (finished || becameUnread) alerts.push({ kind: 'completion', sessionId })
      }
      return alerts
    }

    /**
     * Describe one alert through the Session catalog and the alert locale.
     * @param alert - collected alert.
     * @param sessions - Client Session catalog service.
     * @param t - locale-bound translator.
     * @returns the notification heading and body.
     */
    function describeAlert (alert, sessions, t) {
      let row
      try {
        row = sessions.list.getSnapshot().byId[alert.sessionId]
      } catch {
        row = undefined
      }
      const label = typeof row?.displayTitle === 'string' && row.displayTitle !== ''
        ? row.displayTitle
        : String(alert.sessionId)
      const name = row?.origin === 'subagent' ? `${t('alert.subagent')} ${label}` : label
      if (alert.kind === 'completion') return { title: t('alert.completion'), body: name }
      const kind = alert.interaction?.kind
      const title = kind === 'question'
        ? t('alert.question')
        : kind === 'plan-review'
          ? t('alert.planReview')
          : t('alert.approval')
      const detail = interactionDetail(alert.interaction)
      return { title, body: detail === undefined ? name : `${name} · ${detail}` }
    }

    /**
     * Sound and notify for a batch of alerts.
     * @param alerts - alerts raised by one status update.
     * @param deps - live preferences and services.
     */
    function dispatchAlerts (alerts, deps) {
      const { settings, chime, t, sessions, uiSession, diagnostics } = deps
      const watchId = settings.skipFocused ? watchingSessionId(uiSession, sessions) : undefined
      const observing = settings.skipFocused && userIsPresent() && watchId !== undefined
      const deliver = alerts.filter((alert) => !(observing && alert.sessionId === watchId))
      if (deliver.length === 0) {
        diagnostics.record('watching')
        return
      }
      const urgent = deliver.some((alert) => alert.kind === 'interaction')
      if (settings.sound) chime.play(urgent ? 'interaction' : 'completion')
      const batch = deliver.slice(0, MAX_NOTIFICATIONS_PER_BATCH)
      if (!settings.desktop) {
        diagnostics.record('desktop-off')
        return
      }
      let outcome = 'sent'
      for (const alert of batch) {
        const described = describeAlert(alert, sessions, t)
        const result = showNotification(
          `session-${alert.sessionId}`,
          described.title,
          described.body,
          () => {
            diagnostics.record('failed')
          },
        )
        if (result !== 'sent') outcome = result
      }
      diagnostics.record(outcome)
    }

    // ---------------------------------------------------------------- Settings row

    const ROW_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
    }
    const ROW_TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }
    const ROW_TITLE_STYLE = { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '22px' }
    const ROW_DESC_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' }
    const ROW_CONTROLS_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }
    const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' }
    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      height: '30px',
      padding: '0 12px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'pointer',
    }
    const PILL_ACCENT_STYLE = { ...PILL_STYLE, border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' }

    /**
     * One pill-shaped switch, matching the host's Settings row controls.
     * @param props - label, current value, and change callback.
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
        style: PILL_STYLE,
      }, [
        h('span', { key: 'label' }, label),
        h('span', {
          key: 'track',
          style: {
            position: 'relative',
            display: 'inline-block',
            width: '28px',
            height: '16px',
            borderRadius: '999px',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            transition: 'background 120ms ease',
          },
        }, h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: '2px',
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: 'var(--dsw-alias-bg-layer-1)',
            transform: checked ? 'translateX(12px)' : 'translateX(0)',
            transition: 'transform 120ms ease',
          },
        })),
      ])
    }

    /**
     * Settings → General row for the notifier preferences and the permission handshake.
     * @param props - composed Settings slot props.
     * @returns the preference row.
     */
    function NotifierSettingsRow (props) {
      const { useNotifierSettings, useNotifierStatus, setNotifierSetting, notifierPermission, requestNotifierPermission, testNotifier, testNotifierDelayed, t } = props
      const settings = useNotifierSettings((value) => value)
      const status = useNotifierStatus((value) => value)
      const [permission, setPermission] = React.useState(() => notifierPermission())
      const request = () => {
        Promise.resolve(requestNotifierPermission()).then((state) => {
          setPermission(state)
        }, () => {})
      }
      const toggle = (key) => h(Toggle, {
        key,
        label: t(`toggle.${key}`),
        checked: settings[key] === true,
        onChange: (value) => {
          setNotifierSetting({ [key]: value })
        },
      })
      const lastAttempt = status === undefined || status.result === 'none'
        ? t('status.none')
        : `${new Date(status.at).toLocaleTimeString()} ${t(`status.${status.result}`)}${t(`status.ctx.${status.context ?? 'unknown'}`)}`
      const environment = `${t('env.label')}：${t(detectEnvironment() === 'electron' ? 'env.electron' : 'env.browser')} · ${t('env.api')}：${t(notificationPermission() === 'unsupported' ? 'env.api.no' : 'env.api.yes')}`
      return h('div', { style: ROW_STYLE }, [
        h('div', { key: 'text', style: ROW_TEXT_STYLE }, [
          h('div', { key: 'title', style: ROW_TITLE_STYLE }, t('row.title')),
          h('div', { key: 'desc', style: ROW_DESC_STYLE }, t('row.description')),
        ]),
        h('div', { key: 'controls', style: ROW_CONTROLS_STYLE }, [
          toggle('sound'),
          toggle('desktop'),
          toggle('skipFocused'),
          h('button', {
            key: 'allow',
            type: 'button',
            style: PILL_STYLE,
            disabled: permission === 'granted' || permission === 'unsupported',
            onClick: request,
          }, t('action.allow')),
          h('button', {
            key: 'test',
            type: 'button',
            style: PILL_ACCENT_STYLE,
            onClick: () => {
              testNotifier()
              request()
            },
          }, t('action.test')),
          h('button', {
            key: 'test-delayed',
            type: 'button',
            style: PILL_STYLE,
            onClick: () => {
              testNotifierDelayed()
              request()
            },
          }, t('action.testDelay')),
        ]),
        h('div', { key: 'status', style: HINT_STYLE }, [
          h('span', { key: 'environment' }, environment),
          h('span', { key: 'separator' }, ' · '),
          h('span', { key: 'permission' }, t(PERMISSION_KEYS[permission] ?? 'permission.default')),
          h('span', { key: 'separator2' }, ' · '),
          h('span', { key: 'last' }, `${t('status.last')}${lastAttempt}`),
        ]),
      ])
    }

    // ---------------------------------------------------------------- plugin

    /**
     * Install the notifier and its Settings row for this profile.
     * @param ctx - Client plugin context.
     */
    function apply (ctx) {
      const settings = createSettingsStore()
      const chime = createChime()
      const diagnostics = createDiagnostics()

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-notifier: dictionaries')
      const t = ctx.locale.bind(NS)

      /**
       * Play the alert and, when enabled, request permission. Always called inside a gesture.
       * @param kind - alert kind for the chime.
       */
      const alertNow = (kind) => {
        chime.unlock()
        if (settings.get().sound) chime.play(kind)
        if (!settings.get().desktop) {
          diagnostics.record('desktop-off')
          return
        }
        void requestNotificationPermission().then((state) => {
          if (state !== 'granted') {
            diagnostics.record(state === 'unsupported' ? 'unsupported' : 'no-permission')
            return
          }
          diagnostics.record(showNotification('test', t('alert.interaction'), t('test.body'), () => {
            diagnostics.record('failed')
          }))
        }, () => {
          diagnostics.record('failed')
        })
      }

      // The Settings row is a convenience: a rejected registration must not cost the notifier.
      try {
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'session-notifier',
          order: 30,
          locale: NS,
          inject: () => ({
            hooks: { notifierSettings: settings.source, notifierStatus: diagnostics.source },
            setNotifierSetting: (patch) => {
              settings.update(patch)
            },
            notifierPermission: () => notificationPermission(),
            requestNotifierPermission: () => requestNotificationPermission(),
            testNotifier: () => {
              alertNow('interaction')
            },
            testNotifierDelayed: () => {
              window.setTimeout(() => {
                alertNow('interaction')
              }, 10000)
            },
          }),
        }, NotifierSettingsRow))
      } catch (error) {
        console.warn('session-notifier: Settings row registration failed', error)
      }

      // Audio and notification permission both need a user gesture; the first one unlocks both.
      ctx.effect(() => {
        const onGesture = () => {
          chime.unlock()
          if (settings.get().desktop) void requestNotificationPermission()
        }
        window.addEventListener('pointerdown', onGesture, { capture: true, once: true })
        window.addEventListener('keydown', onGesture, { capture: true, once: true })
        return () => {
          window.removeEventListener('pointerdown', onGesture, { capture: true })
          window.removeEventListener('keydown', onGesture, { capture: true })
        }
      }, 'session-notifier: first gesture unlock')

      ctx.inject(['uiSession', 'sessions'], (scope) => {
        scope.effect(() => {
          const status = scope.uiSession.sessionStatus
          let previous = status.getSnapshot()
          const off = status.subscribe(() => {
            const next = status.getSnapshot()
            const alerts = collectAlerts(previous, next, scope.sessions)
            previous = next
            if (alerts.length === 0) return
            dispatchAlerts(alerts, {
              settings: settings.get(),
              chime,
              t,
              sessions: scope.sessions,
              uiSession: scope.uiSession,
              diagnostics,
            })
          })
          return () => {
            off()
          }
        }, 'session-notifier: Session status')
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
