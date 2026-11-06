// A trade alert on this computer: a toast in the terminal, a sound, and a
// system notification (seen with the window in the background).
import { getSettings } from '../store/settings';
import { beep, useToasts, type Toast } from './engine';

/**
 * The swarm's buys and exits on this computer: a toast in the terminal, a
 * sound, and a system notification (seen with the window in the background).
 */
export function alertHere(title: string, message: string, tone: Toast['tone']) {
  const s = getSettings();
  if (!s.swarmDesktopAlerts) return;
  useToasts.getState().push({ title, message, tone });
  if (s.soundEnabled) beep(tone === 'sell' ? 520 : tone === 'buy' ? 980 : 760, 220);
  if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
    try {
      new Notification(title, { body: message, tag: `swarm-${title}`, silent: true });
    } catch {
      /* not available here */
    }
  }
}
