import { useEffect, useState } from 'react';
import { desktop, type CareConfig, type CareStatus, type TgDelivery, type SecretRecord } from '../desktop/bridge';
import { telegram } from '../desktop/telegram';
import { vault } from '../desktop/vault';
import { openConnections } from '../app/connect';
import { useSettings } from '../store/settings';
import { Check, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export type TelegramConfig = Record<string, never>;
export const TELEGRAM_DEFAULTS: TelegramConfig = {};

export function TelegramPanel(_: PanelProps<TelegramConfig>) {
  const s = useSettings();
  const [bots, setBots] = useState<SecretRecord[]>([]);
  const [me, setMe] = useState<string>('');
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const note = (ok: boolean, text: string) => setLog((l) => [{ ok, text: `${new Date().toLocaleTimeString()} · ${text}` }, ...l].slice(0, 20));

  const reload = () =>
    vault
      .list()
      .then((all) => {
        const t = all.filter((k) => k.kind === 'telegram');
        setBots(t);
        if (!s.telegramSecretId && t[0]) s.set({ telegramSecretId: t[0].id });
      })
      .catch(() => undefined);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bot = bots.find((b) => b.id === s.telegramSecretId);
  const chatId = bot?.meta.fields.chatId;

  useEffect(() => {
    setMe('');
    if (!bot) return;
    telegram
      .me(bot.id)
      .then((m) => setMe(`@${m.username}`))
      .catch((e) => note(false, String(e.message ?? e)));
  }, [bot?.id]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      note(true, typeof r === 'string' ? r : label);
      await reload();
    } catch (e) {
      note(false, String((e as Error).message ?? e));
    }
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={s.telegramSecretId}
          options={[{ value: '', label: bots.length ? 'Choose bot…' : 'No bot yet' }, ...bots.map((b) => ({ value: b.id, label: b.label }))]}
          onChange={(telegramSecretId) => s.set({ telegramSecretId })}
          width={160}
        />
        <span className="muted">{me}</span>
        <Spacer />
        <span className={`status-dot status-${bot && chatId ? 'open' : 'idle'}`} title={chatId ? `chat ${chatId}` : 'not linked'} />
      </Toolbar>
      <div className="scroll" style={{ padding: 10 }}>
        <ol className="steps">
          <li className={bot ? 'done' : ''}>
            In Telegram, message <b>@BotFather</b> → <span className="mono">/newbot</span> and copy the token. Add it in{' '}
            <button className="chip" onClick={openConnections}>
              🔌 Connect → Telegram bot
            </button>
          </li>
          <li className={chatId ? 'done' : ''}>
            Open your bot in Telegram and press <b>Start</b>, then{' '}
            <button className="chip" disabled={!bot} onClick={() => void run('chat linked', async () => `Linked to ${(await telegram.detect(bot!.id)).title}`)}>
              Detect chat
            </button>
            {chatId && <span className="muted mono"> chat {chatId}</span>}
          </li>
          <li>
            <button className="chip" disabled={!chatId} onClick={() => void run('test sent', () => telegram.send(bot!.id, '✅ <b>Novus Ordo is connected</b>\n\n<b>You will hear here when</b>\n• the crypto swarm, the bots or the Luno lane open or close a trade\n• a strategy is ready to deploy, or needs a decision\n• anything stops or needs a look\n\n<i>Send /help for what you can ask.</i>'))}>
              Send test message
            </button>
          </li>
        </ol>
        <div className="section-title">Swarm notifications</div>
        <Check checked={s.telegramSwarm} onChange={(telegramSwarm) => s.set({ telegramSwarm })}>
          <b>Luno lane trades on Telegram</b> <span className="muted">— each buy and sell the Luno lane makes in rands, with its result, and any failure</span>
        </Check>
        <Check checked={s.telegramCrypto} onChange={(telegramCrypto) => s.set({ telegramCrypto })}>
          <b>Crypto swarm trades on Telegram</b> <span className="muted">— each trade three times, with its chart: the setup (potential gain, positioning, the council's votes), how it is being managed, and the result in green or red</span>
        </Check>
        <Check checked={s.telegramBots} onChange={(telegramBots) => s.set({ telegramBots })}>
          <b>Order-flow bot trades on Telegram</b> <span className="muted">— each entry and why, when the trade is safe, each exit with its result, and any failure (Hyperliquid or any exchange)</span>
        </Check>
        <Check checked={s.swarmDesktopAlerts} onChange={(swarmDesktopAlerts) => s.set({ swarmDesktopAlerts })}>
          <b>Pop-up and sound here</b> <span className="muted">— when the swarm or a bot opens or closes a trade, on this computer too</span>
        </Check>
        <label className="check">
          <input type="checkbox" checked={s.telegramCommands} disabled={!chatId} onChange={(e) => s.set({ telegramCommands: e.target.checked })} /> Answer <span className="mono">/price</span>,{' '}
          <span className="mono">/status</span>, <span className="mono">/help</span> (only in your chat, while the app is open)
        </label>
        {desktop?.care && <AwaySection chatReady={!!chatId} onNote={note} />}
        {log.length > 0 && (
          <>
            <div className="section-title">Log</div>
            {log.map((l, i) => (
              <div key={i} className={l.ok ? 'up' : 'down'} style={{ fontSize: 11, padding: '2px 0' }}>
                {l.text}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** did the messages arrive: the last one delivered, or why they are not getting through */
function DeliveryLine({ d }: { d: TgDelivery | null | undefined }) {
  if (!d) return null;
  if (d.failing)
    return (
      <div className="tg-delivery down" data-delivery="failing">
        ⚠ <b>Telegram is not getting the messages</b> — the last {d.failsInRow} failed. {d.lastWhy}
        <div className="muted">
          Last tried {when(d.lastFailAt)}: “{d.lastFailWhat}”{d.lastOkAt ? ` · last delivered ${when(d.lastOkAt)}` : ''}
        </div>
      </div>
    );
  if (d.lastOkAt)
    return (
      <div className="tg-delivery up" data-delivery="ok">
        ✓ Last message delivered {when(d.lastOkAt)}: “{d.lastOkWhat}”
        {d.lastFailAt > d.lastOkAt && <div className="muted">One failed after it ({d.lastWhy}) — the next will be tried as usual.</div>}
      </div>
    );
  return (
    <div className="tg-delivery muted" data-delivery="none">
      No message sent yet{d.lastFailAt ? ` — the last try failed: ${d.lastWhy}` : ''}. “Send one now” above checks the line.
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

/** While you are away: the daily message, warnings, strategy health and the weekly report — sent by the desktop process */
function AwaySection({ chatReady, onNote }: { chatReady: boolean; onNote: (ok: boolean, text: string) => void }) {
  const [st, setSt] = useState<CareStatus | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => void desktop!.care.status().then((x) => live && setSt(x)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  const c = st.cfg;
  const set = (patch: Partial<CareConfig>) => void desktop!.care.config(patch).then(setSt).catch((e) => onNote(false, String(e?.message ?? e)));
  const send = (kind: 'daily' | 'weekly') => {
    setBusy(kind);
    void desktop!.care
      .sendNow(kind)
      .then(() => onNote(true, kind === 'daily' ? "today's check-in sent" : "this week's report sent"))
      .catch((e) => onNote(false, String(e?.message ?? e)))
      .finally(() => setBusy(''));
  };
  return (
    <div data-care>
      <div className="section-title">While you are away</div>
      <p className="muted" style={{ fontSize: 11, margin: '2px 0 6px' }}>
        Sent by Novus Ordo's background engine, so they keep coming even if the window freezes. Novus Ordo must stay open, and it starts sending once the ledger key has been entered.
      </p>
      <Check checked={c.daily} onChange={(daily) => set({ daily })}>
        <b>Daily check-in</b> <span className="muted">— every day: is everything running, the account, open trades, the last 24 hours, the strategies and the edge finder</span>
      </Check>
      <div className="care-row">
        <span className="muted">at</span>
        <Select value={String(c.dailyHour)} options={HOURS} onChange={(v) => set({ dailyHour: Number(v) })} width={80} />
        <button className="chip" disabled={!chatReady || busy !== ''} onClick={() => send('daily')}>
          {busy === 'daily' ? 'Sending…' : 'Send one now'}
        </button>
      </div>
      <Check checked={c.warnings} onChange={(warnings) => set({ warnings })}>
        <b>Warn me when something stops</b> <span className="muted">— the swarm stopping by itself, a price feed down, the edge finder down, the window frozen, a failed exit — and the all-clear when it is back. Also when Novus Ordo starts again after being closed.</span>
      </Check>
      <Check checked={c.health} onChange={(health) => set({ health })}>
        <b>Strategy health</b> <span className="muted">— when a deployed strategy falls behind its test or may have stopped working (it is never switched off for you)</span>
      </Check>
      <Check checked={c.offers} onChange={(offers) => set({ offers })}>
        <b>Offer ready teams — deploy from my phone</b> <span className="muted">— when the edge finder's team pool has a team whose every member is proven on fresh data, it is sent with its numbers and Deploy buttons (council decides, or trade as tested). Nothing is deployed until you tap. Send <span className="mono">/teams</span> to the bot for the whole pool.</span>
      </Check>
      <Check checked={c.wakeNotice} onChange={(wakeNotice) => set({ wakeNotice })}>
        <b>Tell me when it restarts</b> <span className="muted">— after a crash, a power cut or Windows restarting: a message that Novus Ordo is waiting for your ledger key (a fixed message, nothing private in it). Once unlocked, the swarm picks up where it left off, and a crash report follows.</span>
      </Check>
      <Check checked={c.weekly} onChange={(weekly) => set({ weekly })}>
        <b>Weekly report card</b> <span className="muted">— each agent, strategy and bot: trades, wins, profit, what it expected against what it got, real costs, the edge finder's best</span>
      </Check>
      <div className="care-row">
        <span className="muted">on</span>
        <Select value={String(c.weekday)} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} onChange={(v) => set({ weekday: Number(v) })} width={110} />
        <span className="muted">at</span>
        <Select value={String(c.weeklyHour)} options={HOURS} onChange={(v) => set({ weeklyHour: Number(v) })} width={80} />
        <button className="chip" disabled={!chatReady || busy !== ''} onClick={() => send('weekly')}>
          {busy === 'weekly' ? 'Sending…' : 'Send one now'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {!chatReady ? 'Link a Telegram chat above first.' : `Next check-in ${new Date(st.nextDaily).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${st.sentAt ? ` · last message ${new Date(st.sentAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`}
        {st.problems.length > 0 && <div className="down">Needs a look now: {st.problems.map((p) => p.text).join(' · ')}</div>}
      </div>
      {!c.secretId && (
        <div className="tg-delivery down" data-delivery="no-bot">
          ⚠ <b>No Telegram bot for these messages yet</b> — choose your bot at the top of this panel and link its chat (step 2). Until then nothing is sent while you are away.
        </div>
      )}
      <DeliveryLine d={st.delivery} />
    </div>
  );
}
