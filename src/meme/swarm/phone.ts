// The phone side of the swarm wallet: its address on Telegram (tap to copy,
// paste into Phantom), and Phantom verified from the phone by a small exact
// deposit instead of the browser extension on this computer.
import { desktop, type PhoneProof } from '../../desktop/bridge';
import { escapeHtml } from '../../shared/telegram';
import { getSettings } from '../../store/settings';
import { alertHere } from './notify';
import { swarm } from './swarm';

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function addressMessage(address: string): string {
  return `<b>Swarm wallet</b> — tap the address to copy it, then in Phantom: Send → Solana → paste.\n\n<code>${escapeHtml(address)}</code>\n\nSolana network only. Send a small test first.`;
}

export function proofMessage(p: PhoneProof): string {
  return `<b>Verify your Phantom</b>\nIn Phantom: Send → Solana → paste this address:\n\n<code>${escapeHtml(p.address)}</code>\n\nand send exactly\n\n<code>${p.sol}</code> SOL\n\nbefore ${clock(p.until)}. From Phantom only — not from Luno: the wallet it comes from becomes the swarm's home, where profits go. The ${p.sol} SOL stays in the swarm wallet.`;
}

export function verifiedMessage(r: { address?: string; expired?: boolean; refused?: string }): { title: string; text: string; html: string; ok: boolean } {
  if (r.address)
    return {
      ok: true,
      title: 'Phantom verified',
      text: `${short(r.address)} is now the swarm's home wallet. Check it matches Phantom → Receive.`,
      html: `✅ <b>Phantom verified</b>\n<code>${escapeHtml(r.address)}</code>\nis now the swarm's home: withdrawals and profits go here, and nowhere else. Check it matches the address in Phantom → Receive.`,
    };
  if (r.refused) return { ok: false, title: 'Phantom not verified', text: r.refused, html: `⚠️ <b>Phantom not verified</b>\n${escapeHtml(r.refused)}` };
  return { ok: false, title: 'Phantom not verified', text: 'Nothing arrived in 30 minutes — start again from the Wallet.', html: '⌛ <b>Phantom not verified</b>\nNothing arrived in 30 minutes. Start again from the Wallet in Novus Ordo.' };
}

/** True when a Telegram bot is set up to reach the phone. */
export const phoneReady = () => Boolean(desktop && getSettings().telegramSecretId);

export async function tellPhone(html: string) {
  const id = getSettings().telegramSecretId;
  if (!desktop || !id) throw new Error('connect Telegram first (Connect → Telegram) to send this to your phone');
  await desktop.swarm.notify(id, html);
}

let lastAddressSent = 0;
/** The address to the phone; `auto` (on copy) at most once a minute. */
export async function sendAddressToPhone(address: string, auto = false): Promise<boolean> {
  if (auto && (!phoneReady() || Date.now() - lastAddressSent < 60_000)) return false;
  await tellPhone(addressMessage(address));
  lastAddressSent = Date.now();
  return true;
}

let linked = false;
/** The verification result: here and on the phone, whichever screen is open. */
export function startPhoneLink() {
  if (!desktop || linked) return;
  linked = true;
  desktop.swarm.onVerified((r) => {
    const m = verifiedMessage(r);
    alertHere(m.title, m.text, m.ok ? 'buy' : 'info');
    if (phoneReady()) void tellPhone(m.html).catch(() => undefined);
    void swarm.refreshWallet();
    window.dispatchEvent(new CustomEvent('novus:phantom-verified'));
  });
}
