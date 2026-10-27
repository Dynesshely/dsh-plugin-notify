/**
 * dsh-reminder — host half.
 *
 * The reminders live entirely in the browser half: it watches the Client's own
 * Session status (pending question/approval, and a turn that stopped while you
 * were looking at another session) and delivers a chime plus a desktop
 * notification. This module exists because a profile bundle row is a Host-side
 * entry, so the row needs a resolvable package root; it mounts no Host service
 * and registers no route.
 *
 * The browser half is declared by `dsh.client` in this package's manifest and
 * is served from ./client/client.js.
 */

/** Cordis plugin name; the bundle patch and the browser registration share it. */
export const name = 'dsh-reminder'

/** No Host behavior: what deserves a reminder is decided in the page. */
export function apply() {}
