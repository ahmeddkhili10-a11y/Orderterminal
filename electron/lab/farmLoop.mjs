// The edge finder's loop, in its own thread: breed, train, test, forward-test —
// one bot at a time, posting its state to the desktop process as it goes.
// Kept apart from the thread wiring (farmWorker.mjs) so tests can drive it.
import { Farm } from "../../src/lab/farm.ts";
import { setBeat } from "../../src/lab/beat.ts";
import { setCacheCap } from "../../src/lab/library.ts";

// the worked-out series the rules reuse are kept to about 320 MB (they grew without end and ran laptops short of memory)
setCacheCap(320e6);

/** candles as they arrive: packed (six numbers a candle, see packMarkets in lab.mjs) or as objects */
const unpack = (p) => {
  const bars = new Array(p.length / 6);
  for (let i = 0, k = 0; i < bars.length; i++, k += 6)
    bars[i] = { time: p[k], open: p[k + 1], high: p[k + 2], low: p[k + 3], close: p[k + 4], volume: p[k + 5] };
  return bars;
};
const toMarkets = (byTf) =>
  Object.fromEntries(
    Object.entries(byTf ?? {}).map(([tf, ms]) => [
      tf,
      ms.map((m) => ({
        coin: m.coin,
        tfH: m.tfH,
        bars: m.packed ? unpack(m.packed) : m.bars,
        funding: m.funding ? Float64Array.from(m.funding) : null,
      })),
    ]),
  );

/**
 * @param post (msg) => void — posts to the desktop process
 * @param o {{ now?: () => number, sleep?: (ms: number) => Promise<void> }}
 */
export function createFarmRunner(post, o = {}) {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let farm = null;
  let running = false;
  let deployed = [];
  let note = "";
  let looping = null;
  // the heartbeat the desktop process watches (a counter in memory both threads share)
  let beats = null;
  const beat = () => {
    if (beats) Atomics.add(beats, 0, 1);
  };
  const state = () => farm?.state(running, note, "");
  // what was last sent, field by field: only the fields that changed go over, so the desktop
  // process and the screen do not handle (and redraw) the same lists every second and a half
  let sent = new Map();
  const changed = (st, full) => {
    if (full) sent = new Map();
    const out = {};
    for (const [k, v] of Object.entries(st)) {
      const j = JSON.stringify(v ?? null);
      if (full || sent.get(k) !== j) {
        sent.set(k, j);
        out[k] = v;
      }
    }
    return out;
  };
  const send = (full = false) => farm && post({ type: "state", full, state: changed(state(), full) });
  // the save is turned into text here, in this thread, not in the desktop process
  const save = () =>
    farm && post({ type: "save", saveText: JSON.stringify(farm.save()), full: false, state: changed(state(), false) });

  async function loop() {
    let lastPost = 0;
    let lastSave = now();
    while (running) {
      const t0 = performance.now();
      beat();
      try {
        // fresh candles arrived: the survivors' fresh-data records are read again first, a slice at a time
        // (the thread keeps answering; breeding carries on once they are all up to date)
        // (breeding carries on beside it: a slice of re-reading, then a bot)
        const left = farm.forwardPending();
        if (left) {
          farm.forwardSome(250);
          note = farm.forwardPending() ? `Checking ${left} strateg${left === 1 ? "y" : "ies"} against the newest candles…` : "";
        } else if (farm.confirmPending()) {
          // proven strategies re-tested on coins they never saw, a slice at a time
          farm.confirmSome(200);
        } else if (farm.stopsPending()) {
          // strategies found before their stop distances were kept: read again, a few at a time (how they fit your account)
          farm.stopsSome(150);
        }
        farm.step();
      } catch (err) {
        note = `a bot could not be tested: ${String(err?.message ?? err).slice(0, 120)}`;
      }
      const dt = performance.now() - t0;
      if (now() - lastPost > 1500) {
        lastPost = now();
        send();
      }
      if (now() - lastSave > 60_000) {
        lastSave = now();
        save();
      }
      // gentle: rest as long as the work took (about half of one core); full: just let messages in
      await sleep(
        farm.cfg.pace === "full" ? 0 : Math.max(5, Math.min(2000, dt)),
      );
    }
  }

  return {
    async onMessage(msg) {
      if (msg.type === "start") {
        // the costs to test with: measured on your live trades once there are enough of them
        if (msg.beat) {
          beats = new Int32Array(msg.beat);
          setBeat(beat);
        }
        beat();
        const saved = msg.saveText ? JSON.parse(msg.saveText) : (msg.save ?? null);
        farm = new Farm(msg.cfg, { save: saved, now, ...(msg.costs ? { costs: msg.costs } : {}) });
        farm.setMarkets(toMarkets(msg.markets), { defer: true });
        farm.setConfirm(toMarkets(msg.confirm));
        deployed = msg.deployed ?? [];
        farm.checkFleet(deployed);
        note = "";
        running = true;
        send(true);
        looping = loop();
      } else if (msg.type === "markets" && farm) {
        // fresher candles: the survivors' and the fleet's forward tests move on (read again a slice at a time)
        beat();
        farm.setMarkets(toMarkets(msg.markets), { defer: true });
        if (msg.confirm) farm.setConfirm(toMarkets(msg.confirm));
        farm.checkFleet(deployed);
        send();
        save();
      } else if (msg.type === "account" && farm) {
        // the account the strategies are judged for: the lists and offers follow at once (nothing is re-tested)
        farm.cfg.accountUsd = msg.usd;
        farm.cfg.accountZar = msg.zar ?? null;
        farm.reboard();
        send();
        save();
      } else if (msg.type === "pin" && farm) {
        farm.pin(msg.id, msg.on);
        send();
        save();
      } else if (msg.type === "fleet" && farm) {
        deployed = msg.deployed ?? [];
        farm.checkFleet(deployed);
        send();
      } else if (msg.type === "stop") {
        running = false;
        await looping;
        if (farm) post({ type: "save", saveText: JSON.stringify(farm.save()), full: true, state: changed(state(), true) });
        post({ type: "stopped" });
      }
    },
    /** for tests */
    get farm() {
      return farm;
    },
  };
}
