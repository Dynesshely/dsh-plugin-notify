/**
 * Host half of the Session notifier bundle.
 *
 * Every alert is decided and delivered in the browser half (`client.js`,
 * declared by `dsh.client` in package.json): it watches the Client Session
 * status projection, decides whether a session genuinely needs the user, and
 * delivers a chime plus a desktop notification. This entry exists because a
 * profile bundle row is a Host-side Loader entry that needs a resolvable
 * package root; it mounts no service and registers no route.
 */

/** Cordis plugin name; the bundle patch and the browser registration share it. */
export const name = 'session-notifier'

/** No Host behavior: what deserves an alert is decided in the page. */
export function apply() {}
