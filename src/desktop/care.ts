// The desktop process looks after the terminal while you are away (electron/care):
// it sends through the Telegram bot chosen on the Telegram panel, so the choice
// is passed to it at start and whenever it changes.
import { getSettings, useSettings } from '../store/settings';
import { desktop } from './bridge';

let linked = false;

export function startCareLink() {
  if (!desktop?.care || linked) return;
  linked = true;
  const push = (id: string) => void desktop!.care.config({ secretId: id }).catch(() => undefined);
  push(getSettings().telegramSecretId);
  useSettings.subscribe((s, prev) => {
    if (s.telegramSecretId !== prev.telegramSecretId) push(s.telegramSecretId);
  });
}
