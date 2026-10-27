/**
 * Host half of the Session notifier bundle.
 *
 * Alerts are raised where the user is: the browser half (`client.js`, declared through
 * `dsh.client` in `package.json`) observes the Session status projection and plays a
 * sound plus a desktop notification. This entry only has to exist and stay inert.
 */
export function apply() {}
