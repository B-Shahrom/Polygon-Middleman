// Thin wrapper over the Web Notifications API — the OS-level desktop notifications
// browsers show even when the tab isn't focused. Used to ping the user when the
// import queue drains so they don't have to babysit it.

export function canNotify(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Ask for permission. Call from a user gesture (e.g. clicking Import). */
export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!canNotify()) return 'denied';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

/** Fire a desktop notification. Returns false if unsupported / not granted.
 *  `silent` suppresses the notification sound — used for the error/warning
 *  variant so it's noticeable but not annoying. */
export function notify(title: string, body: string, opts: { silent?: boolean } = {}): boolean {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  try {
    // `tag` collapses repeat notifications instead of stacking them.
    const n = new Notification(title, { body, tag: 'polygon-middleman-queue', silent: opts.silent });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}
