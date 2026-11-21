// FARM — the edge finder: a strategy farm that runs by itself while the
// terminal is open. Bots are bred from the bot builder's blocks, trained on
// the first 70 % of the history, and must survive the unseen 30 %, the
// steadiness and double-cost checks, 100 random bots, their settings nudged,
// 1,000 shuffles and a significance test that allows for every bot tried. The
// survivors are forward-tested on fresh data; the best five are here, with
// the team that fits together best, what the search has learned and how
// overfit it is — ready to open in the bot builder or deploy to the crypto
// swarm, which is the user's call.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktop, type FarmView } from "../desktop/bridge";
import { sendToBot } from "../lab/bridge";
import {
  cardWords,
  isStar,
  LADDER,
  sizedUp,
  STAGES,
  type FleetItem,
  type PaceBoard,
  type Survivor,
  type Team,
} from "../lab/farm";
import { buildSpec, STYLE_MAP, STYLES, type StyleId } from "../lab/flow";
import { startLabLink, useLab, type Authority } from "../lab/store";
import { testedStats } from "../lab/live";
import { Popover, type PanelProps } from "../ui/controls";
import { Bars, LineChart } from "./charts";

const pct = (x: number, d = 1) =>
  !Number.isFinite(x)
    ? "—"
    : Math.abs(x) >= 100
      ? `${x > 0 ? ">" : "<−"}10,000%`
      : `${(x * 100).toFixed(d)}%`;
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const int = (x: number) =>
  Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "—";
const ago = (t: number, now: number) => {
  if (!t) return "never";
  const m = Math.round((now - t) / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 48 * 60
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} days ago`;
};
const paceOf = (s: StyleId) => STYLE_MAP[s]?.name.split(" — ")[0] ?? s;
const STAGE_TONE: Record<string, string> = {
  new: "",
  incubating: "muted",
  proving: "up",
  proven: "up b",
  faded: "down",
};

export interface FarmConfig {
  explain: boolean;
  /** each pace's top five: best overall (quality) or best return */
  sort?: "quality" | "return";
}
export const FARM_PANEL_DEFAULTS: FarmConfig = { explain: true };

export function FarmPanel({ config: c, setConfig }: PanelProps<FarmConfig>) {
  useEffect(() => startLabLink(), []);
  const farm = useLab((s) => s.farm);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(Date.now());
  const listed = useRef<Survivor[]>([]);
  const onTeamSel = useCallback((id: string) => {
    if (listed.current.some((x) => x.id === id)) setSel(id);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  // the strategy on show stays on show: it is chosen once (the first listed) and then only by a click
  const shown = useRef<Survivor | null>(null);
  const firstId =
    farm?.tops?.find((b) => b.rows.length)?.rows[0].id ??
    farm?.top[0]?.id ??
    null;
  useEffect(() => {
    if (!sel && firstId) setSel(firstId);
  }, [sel, firstId]);
  if (!desktop?.lab?.farm)
    return (
      <div className="pro-empty">
        The edge finder runs in the desktop app (it breeds and tests bots on
        years of history, all the time).
      </div>
    );
  if (!farm)
    return <div className="pro-empty">Connecting to the edge finder…</div>;
  const F = desktop.lab.farm;
  const act = (p: Promise<unknown>, done?: string) => {
    setBusy(true);
    setMsg("");
    p.then(() => done && setMsg(done))
      .catch((e) => setMsg(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };
  // a top five for each pace (a state saved by an earlier version has one list for all)
  const boards: PaceBoard[] =
    farm.tops ??
    (farm.top.length + farm.watch.length
      ? [
          {
            id: "all",
            name: "All paces",
            rows: [...farm.top, ...farm.watch],
            held: farm.survivors,
            live: farm.survivors,
          },
        ]
      : []);
  const kept = farm.kept ?? [];
  const keptIds = new Set(kept.map((x) => x.id));
  // proven and over 200 % a year: the ones offered on the phone, listed whether or not they make a pace's top five
  const stars = farm.stars ?? [];
  const byReturn = c.sort === "return";
  const rowsOf = (b: PaceBoard) => (byReturn ? b.byRet ?? b.rows : b.rows);
  const all = [...kept, ...stars, ...boards.flatMap((b) => rowsOf(b)), ...boards.flatMap((b) => b.byRet ?? [])];
  listed.current = all;
  const found = all.find((s) => s.id === sel) ?? null;
  if (found) shown.current = found;
  // one that has left the lists since it was picked stays on show until another is clicked
  const pick =
    found ?? (sel && shown.current?.id === sel ? shown.current : null) ?? all[0] ?? null;
  const rankOf = (s: Survivor) => {
    for (const b of boards) {
      const i = rowsOf(b).findIndex((r) => r.id === s.id);
      if (i >= 0) return { n: i + 1, pace: b.name };
    }
    const k = stars.findIndex((r) => r.id === s.id);
    if (k >= 0) return { n: k + 1, pace: "⭐ Stars" };
    return null;
  };
  const running = farm.running;
  const starting = !!farm.starting;
  return (
    <div className="pro-panel farm" data-farm>
      <div className="farm-head">
        <span
          className={`farm-dot ${running ? "on" : starting ? "wait" : ""}`}
        />
        <div className="farm-title">
          <b>Edge finder</b>
          <span className="muted">
            {running
              ? `Running · generation ${int(farm.gen)} · ${int(farm.tried)} bots tried · ${num(farm.rate, 0)} a minute`
              : starting
                ? farm.note || "Starting…"
                : farm.tried
                  ? `Stopped · ${int(farm.tried)} bots tried so far — its survivors are kept`
                  : "Stopped"}
          </span>
        </div>
        <span className="grow" />
        <Settings
          farm={farm}
          busy={busy || starting}
          onApply={(patch) =>
            act(
              F.start(patch),
              "Restarted with the new settings: survivors already found are kept.",
            )
          }
        />
        <span className="farm-sort" data-sort>
          <button className={`chip ${byReturn ? "" : "active"}`} onClick={() => setConfig({ sort: "quality" })} title="Each pace's top five by overall quality: steadiness, fresh data, significance">
            Best overall
          </button>
          <button className={`chip ${byReturn ? "active" : ""}`} onClick={() => setConfig({ sort: "return" })} title="Each pace's top five by a year's return (at 1× or sized up), proven first">
            Best return
          </button>
        </span>
        <label className="check">
          <input
            type="checkbox"
            checked={c.explain}
            onChange={(e) => setConfig({ explain: e.target.checked })}
          />{" "}
          Explain
        </label>
        {running || starting ? (
          <button
            className="btn farm-stop"
            disabled={busy}
            onClick={() =>
              act(
                F.stop(),
                "Stopped. Everything it found is kept; it stays stopped until you start it again.",
              )
            }
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="btn bb2-primary farm-start"
            disabled={busy}
            onClick={() => act(F.start())}
          >
            ▶ Start
          </button>
        )}
      </div>
      {farm.error && <div className="lab-error">{farm.error}</div>}
      {msg && (
        <div className="lab-note" onClick={() => setMsg("")}>
          {msg}
        </div>
      )}
      <div className="pro-scroll">
        <Status farm={farm} now={now} />
        {c.explain && (
          <div className="farm-intro">
            Every bot is treated as curve-fitted until it proves it is not. The
            edge finder breeds bots from the bot builder’s blocks, trains each
            on the first part of the history, and keeps it only if it survives
            every check of the gauntlet — the last of them the <b>vault</b>: the
            most recent 15 % of the history, which nothing is bred or checked
            on, so a bot that passes has a result on fresh data the moment it
            is found. Each pace has its own population and its own top five.
            One survivor is kept of each kind (pace, strategies, filters):
            copies of a kind are one idea, tested once. It runs by itself while
            the terminal is open; deploying is always your call.
          </div>
        )}

        {boards.length === 0 && (
          <div className="lab-note">
            {running || starting
              ? "No bot has survived every check yet. That is the point: most ideas do not hold up on data they never saw. Leave it running — a strategy appears here the moment one earns it."
              : "Nothing has survived every check yet. Press Start and leave it running while you use the terminal."}
          </div>
        )}
        {kept.length > 0 && (
          <div data-kept>
            <div className="pro-section farm-board-head">
              <span>★ KEPT — THE STRATEGIES YOU CHOSE TO KEEP</span>
              <span className="muted">never dropped · {kept.length}</span>
            </div>
            <Table rows={kept} sel={pick?.id ?? null} onSel={setSel} />
          </div>
        )}
        {stars.length > 0 && (
          <div data-stars>
            <div className="pro-section farm-board-head">
              <span>⭐ STARS — PROVEN AND OVER 200 % A YEAR (OFFERED ON YOUR PHONE)</span>
              <span className="muted">{stars.length} · /stars on Telegram</span>
            </div>
            {c.explain && (
              <div className="lab-line muted">
                Proven on fresh data and over 200 % a year on data they never saw, at 1× or sized up to a 15 % worst drop. Each pace’s top five below is ordered by overall quality (steadiness, fresh data, significance), not by return — so a star can be missing from it.
              </div>
            )}
            <Table rows={stars} sel={pick?.id ?? null} onSel={setSel} />
          </div>
        )}
        {boards.map((b) => (
          <div key={b.id} data-board={b.id}>
            <div className="pro-section farm-board-head">
              <span>
                {b.name.toUpperCase()} — TOP {Math.max(5, rowsOf(b).length)}
                {byReturn ? " BY RETURN" : ""}
              </span>
              <span className="muted">
                {b.live
                  ? `${b.live} standing${b.held > b.live ? ` · ${b.held - b.live} faded` : ""}`
                  : "none standing yet"}
              </span>
            </div>
            {rowsOf(b).length ? (
              <Table rows={rowsOf(b)} sel={pick?.id ?? null} onSel={setSel} />
            ) : (
              <div className="lab-line muted farm-none">
                {running || starting
                  ? "Nothing has survived at this pace yet — it is being bred and tested alongside the others."
                  : "Nothing has survived at this pace yet."}
              </div>
            )}
          </div>
        ))}
        {pick && (
          <Detail
            key={pick.id}
            s={pick}
            rank={rankOf(pick)}
            onMsg={setMsg}
            explain={c.explain}
            kept={keptIds.has(pick.id)}
          />
        )}

        <div className="pro-section">
          THE TEAM POOL — UP TO FIVE TEAMS: ONE SCALPING, ONE INTRADAY AND ONE SWING STRATEGY EACH
        </div>
        {(farm.teams?.length ?? 0) > 0 ? (
          <TeamPool
            teams={farm.teams!}
            explain={c.explain}
            onSel={onTeamSel}
            onMsg={setMsg}
          />
        ) : (
          <div className="lab-line muted farm-none" data-team-none>
            <b>No proven team yet — nothing to deploy.</b> A team is made only of proven edges: each of its scalping, intraday and swing strategies must be significant on the unseen data <i>and</i> have 25 or more trades on fresh data, in profit, with a Sharpe of 0.75 or more.
            {!(farm.cfg.styles.some((x) => x === "scalp" || x === "scalp15") && farm.cfg.styles.some((x) => x === "intraday" || x === "intraday15") && farm.cfg.styles.some((x) => x === "swing" || x === "week")) && " Add the scalping, intraday and swing paces under ⚙ Settings."}
            {(farm.teamWait ?? []).map((w) => (
              <div key={w.pace} data-wait={w.pace}>
                • <b>{w.pace[0].toUpperCase() + w.pace.slice(1)}</b>: {w.proven ? <span className="up">{w.proven} proven edge{w.proven === 1 ? "" : "s"} ✓</span> : "none proven yet"}
                {!w.proven && w.best ? ` — closest: ${w.best.name.split(" · ")[0]} (${w.best.missing.join("; ")})` : !w.proven ? " — nothing standing yet" : ""}
              </div>
            ))}
          </div>
        )}

        {farm.fleet.length > 0 && (
          <>
            <div className="pro-section">
              THE LIVE FLEET — YOUR DEPLOYED STRATEGIES ON FRESH DATA
            </div>
            <Fleet fleet={farm.fleet} top={farm.top} onMsg={setMsg} />
          </>
        )}

        <div className="farm-grid">
          <div>
            <div className="pro-section">
              THE GAUNTLET — HOW MANY BOTS GOT THROUGH EACH CHECK
            </div>
            <Funnel farm={farm} explain={c.explain} />
          </div>
          <div>
            <div className="pro-section">
              FRESH DATA — THE SURVIVORS SINCE THEY WERE FOUND
            </div>
            <div className="farm-ladder">
              {LADDER.map((l) => (
                <div
                  key={l.id}
                  className={`farm-rung r-${l.id}`}
                  title={l.plain}
                >
                  <b className="mono">{farm.ladder[l.id] ?? 0}</b>
                  <span>{l.name}</span>
                </div>
              ))}
            </div>
            {c.explain && (
              <div className="lab-line muted">
                A survivor’s fresh-data record starts with the vault and carries
                on into the candles that arrive after it was found. Fewer than 8
                trades there is incubating; 8 or more and in profit is proving;
                25 or more, in profit, with a Sharpe of 0.75 or more is proven —
                and it stays proven while its Sharpe stays above 0.5 and it stays
                in profit, so one trade either way does not flip it. One that
                loses fades and is dropped, and its kind is not tried again.
              </div>
            )}
            <div className="pro-section">THE SEARCH ITSELF</div>
            <Search farm={farm} explain={c.explain} />
          </div>
        </div>

        {(farm.blocks?.length ?? 0) > 0 && (
          <>
            <div className="pro-section">
              WHAT IS WORKING — THE BLOCKS BEHIND THE BOTS THAT GOT FURTHEST
            </div>
            <Blocks farm={farm} explain={c.explain} />
          </>
        )}

        <div className="pro-section">LATEST VERDICTS</div>
        <div className="farm-log">
          {farm.recent.length ? (
            farm.recent.slice(0, 10).map((r, i) => (
              <div
                key={i}
                className={`farm-log-row ${r.at === "proof" ? "up" : ""}`}
              >
                <span className="mono muted">
                  {new Date(r.t).toISOString().slice(11, 16)}
                </span>
                <b>
                  {r.at === "proof"
                    ? "survived"
                    : r.why.startsWith("passed every check")
                      ? "candidate"
                      : `out at: ${STAGES.find((x) => x.id === r.at)?.name.toLowerCase() ?? r.at}`}
                </b>
                <span className="farm-log-name">{r.name}</span>
                <span className="muted">{r.why}</span>
              </div>
            ))
          ) : (
            <div className="lab-line muted">
              Only the bots that trained well face the checks; their verdicts
              appear here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Funnel({ farm, explain }: { farm: FarmView; explain: boolean }) {
  const max = Math.max(1, farm.funnel.bred);
  return (
    <div className="farm-funnel">
      {STAGES.map((s, i) => {
        const n = farm.funnel[s.id] ?? 0;
        const prev = i ? (farm.funnel[STAGES[i - 1].id] ?? 0) : n;
        return (
          <div
            key={s.id}
            className="farm-step"
            title={s.plain}
            data-stage={s.id}
          >
            <span className="farm-step-name">
              {i + 1}. {s.name}
            </span>
            <span className="farm-bar">
              <i
                style={{
                  width: `${Math.max(n ? 1.5 : 0, Math.sqrt(n / max) * 100)}%`,
                }}
              />
            </span>
            <b className="mono">{int(n)}</b>
            <span className="mono muted">
              {i ? (prev ? pct(n / prev, 0) : "—") : ""}
            </span>
            {explain && <small className="muted">{s.plain}</small>}
          </div>
        );
      })}
    </div>
  );
}

/** how strong the evidence for a survivor is, in a word or two */
// Each part of the screen redraws only when what it shows changed: the edge finder's state
// arrives every second and a half, but its lists change at most every 20 seconds.
const Table = memo(TableView);
const Detail = memo(
  DetailView,
  (a, b) => a.s === b.s && a.rank?.n === b.rank?.n && a.rank?.pace === b.rank?.pace && a.explain === b.explain && a.kept === b.kept && a.onMsg === b.onMsg,
);
const TeamPool = memo(TeamPoolView);
const Fleet = memo(FleetView);

function evidence(s: Survivor): { text: string; tone: string } {
  if (isStar(s)) return { text: "⭐ Proven · over 200 %", tone: "up b" };
  if (s.stage === "proven")
    return { text: s.sig ? "Proven · significant" : s.confirmed ? "Proven · confirmed on new coins" : "Proven on fresh data", tone: "up b" };
  if (s.stage === "proving")
    return { text: s.slip ? "Proving · was proven" : s.sig ? "Proving · significant" : "Proving on fresh data", tone: "up" };
  if (s.sig) return { text: "Significant", tone: "up" };
  return { text: "Candidate", tone: "muted" };
}

function TableView({
  rows,
  sel,
  onSel,
}: {
  rows: Survivor[];
  sel: string | null;
  onSel: (id: string) => void;
}) {
  return (
    <div className="farm-wide">
      <table className="pro-table farm-table">
        <thead>
          <tr>
            <th className="l">#</th>
            <th className="l">STRATEGY</th>
            <th
              className="l"
              title="Proven or proving on fresh data (the vault and the candles since), significant after every kind tried, or a candidate still to prove itself"
            >
              EVIDENCE
            </th>
            <th title="A year’s return on the unseen 30 %, trading one times the account (no leverage)">A YEAR · 1×</th>
            <th title="The same edge sized up until its worst drop on the unseen 30 % would have been 15 %, at most 5× — every loss grows by the same multiple. Simple scaling: compounding and the swarm’s risk rules left out.">SIZED UP</th>
            <th title="Return for the risk on the unseen 30 %">SHARPE</th>
            <th title="The biggest fall from a high on the unseen 30 %">
              WORST DROP
            </th>
            <th title="Share of months (or weeks) that made money on the unseen 30 %">
              MONTHS UP
            </th>
            <th title="Its result in the vault — the most recent 15 % of the history, which nothing is bred or checked on — and on the candles that have arrived since it was found">
              FRESH DATA
            </th>
            <th title="The chance it is a fluke, allowing for every kind of bot that reached the unseen data (its q-value): under 10 % counts as significant">
              FLUKE ODDS
            </th>
            <th className="l">LADDER</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const ev = evidence(s);
            return (
              <tr
                key={s.id}
                className={sel === s.id ? "sel" : ""}
                onClick={() => onSel(s.id)}
                data-survivor={s.id}
              >
                <td className="l b">{i + 1}</td>
                <td className="l farm-name" title={s.name}>
                  {s.name.split(" · ").slice(0, 2).join(" · ")}
                </td>
                <td className={`l ${ev.tone}`}>{ev.text}</td>
                <td className={`mono ${s.oos.cagr >= 0 ? "up" : "down"}`}>
                  {pct(s.oos.cagr, 0)}
                </td>
                <td className={`mono b ${s.oos.cagr >= 0 ? "up" : "down"}`} data-sized>
                  {(() => {
                    const z = sizedUp(s.oos.cagr, s.oos.maxDD);
                    return `${pct(z.ret, 0)} · ${num(z.lev, 1)}×`;
                  })()}
                </td>
                <td className="mono">{num(s.oos.sharpe)}</td>
                <td className="mono down">{pct(-s.oos.maxDD)}</td>
                <td className="mono">{pct(s.periods.up, 0)}</td>
                <td
                  className={`mono ${s.forward && s.forward.trades ? (s.forward.ret >= 0 ? "up" : "down") : "muted"}`}
                >
                  {s.forward && s.forward.trades
                    ? `${pct(s.forward.ret)} · ${s.forward.trades} tr · ${num(s.forward.days, 0)} d`
                    : "waiting"}
                </td>
                <td className={`mono ${s.sig ? "up" : "muted"}`}>
                  {s.q === undefined
                    ? "—"
                    : s.q < 0.001
                      ? "<0.1%"
                      : pct(s.q, s.q < 0.1 ? 1 : 0)}
                </td>
                <td className={`l ${STAGE_TONE[s.stage] ?? ""}`}>
                  {LADDER.find((l) => l.id === s.stage)?.name ?? s.stage}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailView({
  s,
  rank,
  onMsg,
  explain,
  kept,
}: {
  s: Survivor;
  rank: { n: number; pace: string } | null;
  onMsg: (m: string) => void;
  explain: boolean;
  kept: boolean;
}) {
  const [authority, setAuthority] = useState<Authority>("council");
  const [done, setDone] = useState(false);
  const built = useMemo(() => buildSpec(s.flow), [s]);
  const checks = [
    {
      name: "Trained",
      value: `Sharpe ${num(s.is.sharpe)} on the first 70 % · ${s.is.trades} trades`,
      pass: true,
    },
    {
      name: "Unseen 30 %",
      value: `Sharpe ${num(s.oos.sharpe)} · ${pct(s.oos.totalReturn)} · ${s.oos.trades} trades · win rate ${pct(s.oos.winRate, 0)}`,
      pass: true,
    },
    ...(s.checks
      ? [
          {
            name: "Steady",
            value: `in profit in ${s.checks.thirds} of 3 thirds of the unseen stretch · on ${s.checks.coinsUp} of ${s.checks.coins} coin${s.checks.coins === 1 ? "" : "s"} · ${s.checks.noBest >= 0 ? "+" : ""}${num(s.checks.noBest, 1)} R without its best 5 % of trades`,
            pass: true,
          },
          {
            name: "Double costs",
            value: `Sharpe ${num(s.checks.cost2)} at twice the fees and slippage (${num(s.oos.sharpe)} at normal costs)`,
            pass: s.checks.cost2 > 0,
          },
        ]
      : []),
    {
      name: "100 random bots",
      value: `beat ${s.beat} of 100`,
      pass: s.beat >= 75,
    },
    {
      name: "Settings nudged",
      value: `${s.nudge.kept} of ${s.nudge.tried} still made money`,
      pass: s.nudge.kept >= s.nudge.tried / 2,
    },
    {
      name: "1,000 shuffles",
      value: `unlucky drawdown ${pct(s.mc.dd95, 0)} at 1 % risk a trade · ${pct(s.mc.pLoss, 0)} of orders end lower`,
      pass: true,
    },
    {
      name: "Significant",
      value: `t = ${num(s.oos.t)} · odds it is a fluke, allowing for every kind of bot that reached the unseen data: ${s.q === undefined ? "—" : s.q < 0.001 ? "under 0.1 %" : pct(s.q, 1)} (under 10 % counts)${s.sig ? "" : " — a candidate: fresh data can still prove it"}`,
      pass: s.sig,
    },
    ...(s.vault
      ? [
          {
            name: "The vault",
            value: s.vault.trades
              ? `${pct(s.vault.ret)} over ${s.vault.trades} trade${s.vault.trades === 1 ? "" : "s"} in the ${num(s.vault.days, 0)} most recent days of the history, which nothing was bred or checked on`
              : `no trades in its ${num(s.vault.days, 0)} days yet`,
            pass: s.vault.ret >= 0,
          },
        ]
      : []),
    {
      name: "Fresh data",
      value:
        s.forward && s.forward.trades
          ? `${pct(s.forward.ret)} over ${s.forward.trades} trades in ${num(s.forward.days, 0)} days${s.vault ? " (the vault and the candles since)" : ""} · Sharpe ${num(s.forward.sharpe)}${s.vault && s.forward.trades > s.vault.trades ? ` · ${s.forward.trades - s.vault.trades} of them since it was found` : ""}`
          : "no trades on new candles yet",
      pass: !s.forward || s.forward.ret >= 0,
    },
  ];
  const open = () => {
    sendToBot({
      block: "flow",
      id: "flow",
      from: "the edge finder",
      flow: s.flow,
      name: s.name,
    });
    onMsg(
      `Opened “${s.name}” in the bot builder (BOT): every block shows what it is built of.`,
    );
  };
  const deploy = () => {
    if (!desktop?.lab) return;
    void desktop.lab
      .deploy(
        {
          spec: { ...built.spec, name: s.name },
          tfH: s.tfH,
          stats: {
            sharpe: s.oos.sharpe,
            t: s.oos.t,
            dsr: s.dsr,
            trades: s.oos.trades,
              ...testedStats(s.oos, s.tfH),
            verdict: `edge finder · ${s.stage}`,
          },
          authority,
        },
        { crypto: true, meme: false },
        s.coins,
      )
      .then(() => {
        setDone(true);
        onMsg(
          `Deployed “${s.name}” to the crypto swarm (${authority === "tested" ? "trades as tested" : "the council decides"}). The edge finder now watches it on fresh data in “The live fleet”.`,
        );
      })
      .catch((e) => onMsg(String(e?.message ?? e)));
  };
  return (
    <div className="farm-detail" data-detail>
      <div className="pro-section">
        {rank ? `${rank.pace.toUpperCase()} #${rank.n} — ` : "NO LONGER LISTED — "}
        {s.name.toUpperCase()}
      </div>
      {s.card && (
        <div className="farm-card" data-card>
          <b>WHAT DEPLOYING IT MEANS</b>
          {cardWords(s.card).map((x) => (
            <div key={x}>• {x}</div>
          ))}
        </div>
      )}
      {s.confirm && (
        <div className={`lab-line ${s.confirmed ? "up" : "muted"}`} data-confirm>
          {s.confirmed ? "✓ Confirmed" : "Not confirmed"} on coins it was never bred on ({s.confirm.coins.join(", ")}): in profit on {s.confirm.up} of {s.confirm.coins.length}, {s.confirm.trades} trades, {pct(s.confirm.ret)} pooled, Sharpe {num(s.confirm.sharpe)} — the chance of that by luck, allowing for every strategy re-tested, {num((s.confirm.q ?? s.confirm.p) * 100, 1)} %.
        </div>
      )}
      {s.stage === "proven" && s.provenAt ? (
        <div className="lab-line up" data-proven-since>
          ✓ Proven on fresh data since {new Date(s.provenAt).toISOString().slice(0, 10)} — it keeps the badge while it stays in profit with a Sharpe above 0.5 there.
        </div>
      ) : s.slip ? (
        <div className="lab-line warn" data-slip>
          ⚠ Was proven until {new Date(s.slip.at).toISOString().slice(0, 16).replace("T", " ")} UTC: {s.slip.why}. It earns the badge back at 25+ trades, in profit, with a Sharpe of 0.75 or more on fresh data.
        </div>
      ) : null}
      <div className="lab-grid2">
        <div>
          <ul className="farm-rules">
            {s.summary.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <LineChart
            series={[
              {
                values: s.curve,
                color: "var(--pro-head, #ffd200)",
                width: 1.6,
              },
            ]}
            marker={Math.round(s.curve.length * 0.69)}
            height={150}
            labels={
              <>
                the whole history at unit size · trained left of the line, never
                seen right of it · found{" "}
                {new Date(s.foundAt).toISOString().slice(0, 10)}
              </>
            }
          />
        </div>
        <div>
          <table className="pro-table compact farm-checks">
            <tbody>
              {checks.map((k) => (
                <tr key={k.name}>
                  <td className={`l b ${k.pass ? "up" : "down"}`}>
                    {k.pass ? "✓" : "✕"}
                  </td>
                  <td className="l b">{k.name}</td>
                  <td className="l">{k.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.periods.list.length > 0 && (
            <Bars
              rows={s.periods.list
                .slice(-12)
                .map((p) => ({
                  label: new Date(p.t).toLocaleDateString(
                    "en-GB",
                    s.periods.unit === "week"
                      ? { day: "2-digit", month: "short", timeZone: "UTC" }
                      : { month: "short", year: "2-digit", timeZone: "UTC" },
                  ),
                  value: p.ret,
                }))}
              format={(v) => pct(v, 1)}
            />
          )}
          <div className="lab-line mono muted">
            {s.periods.unit === "week" ? "weeks" : "months"} on the unseen data:{" "}
            {pct(s.periods.up, 0)} positive · average {pct(s.periods.avg, 1)} ·
            worst {pct(s.periods.worst, 1)}
          </div>
        </div>
      </div>
      <div className="farm-actions">
        <button
          className="btn farm-open"
          onClick={open}
          title="Open it in the bot builder: every block shows what it is built of; test it there for the full read-out and the optimizer"
        >
          Open in the bot builder
        </button>
        <button
          className={`btn${kept ? " active" : ""}`}
          data-keep
          onClick={() =>
            void desktop?.lab?.farm
              ?.pin(s.id, !kept)
              .then(() => onMsg(kept ? `“${s.name}” is no longer kept: it stays while it holds its place.` : `Kept “${s.name}”: it stays on the KEPT list for good, whatever newer strategies or fresh candles do.`))
              .catch((e) => onMsg(String(e?.message ?? e)))
          }
          title="Keep this strategy for good: it is never dropped from the lists, even when newer ones score higher or the candles reload"
        >
          {kept ? "★ Kept" : "☆ Keep"}
        </button>
        <span className="muted">Who decides its trades:</span>
        <button
          className={`chip${authority === "council" ? " active" : ""}`}
          onClick={() => setAuthority("council")}
          title="It proposes; the swarm’s council votes and can block a signal"
        >
          Council decides
        </button>
        <button
          className={`chip${authority === "tested" ? " active" : ""}`}
          onClick={() => setAuthority("tested")}
          title="It takes every signal it was tested on; only Guardian and Risk can stop a trade"
        >
          Trade as tested
        </button>
        <button
          className="btn bb2-primary farm-deploy"
          disabled={done}
          onClick={deploy}
        >
          {done ? "✓ Deployed" : "⇢ Deploy to the crypto swarm"}
        </button>
      </div>
      {explain && s.stage === "new" && (
        <div className="lab-line muted">
          Found{" "}
          {new Date(s.foundAt).toISOString().slice(0, 16).replace("T", " ")}{" "}
          UTC. It has passed every test on history; fresh candles will show
          whether it keeps working. Deploying now is your call — many traders
          wait for “proving”.
        </div>
      )}
    </div>
  );
}

/** the edge finder at a glance: the engine, its data, what is standing, how the search is going */
/** an exchange's error, in words */
function whyWords(e: string): string {
  if (/429|rate.?limit|too many|ddos|exceeded/i.test(e)) return "the exchange asked for fewer requests a minute (a rate limit) — it waits five minutes before trying again.";
  if (/did not answer|timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(e)) return "no answer from the exchange (the internet connection, or the exchange is slow).";
  return e.length > 160 ? `${e.slice(0, 160)}…` : e;
}

function Status({ farm, now }: { farm: FarmView; now: number }) {
  const d = farm.data;
  const mins = (t: number) => Math.max(0, Math.round((t - now) / 60_000));
  const newest = farm.dataTo
    ? new Date(farm.dataTo).toISOString().slice(0, 16).replace("T", " ")
    : "—";
  const L = farm.ladder;
  const standing = (L.new ?? 0) + (L.incubating ?? 0) + (L.proving ?? 0) + (L.proven ?? 0);
  const bad = !!d && !d.ok;
  return (
    <div className="farm-status" data-status>
      <div>
        <small>ENGINE</small>
        <b className={farm.running ? "up" : "muted"}>
          {farm.running ? "Running" : farm.starting ? "Starting…" : "Stopped"}
        </b>
        <span className="muted">
          {int(farm.tried)} bots tried
          {farm.running ? ` · ${num(farm.rate, 0)} a minute` : ""} · generation{" "}
          {int(farm.gen)}
        </span>
      </div>
      <div data-data={bad ? "healing" : "ok"}>
        <small>DATA</small>
        <b className={bad ? "warn" : "up"}>
          {bad
            ? d!.missing.length
              ? "Some markets missing — retrying"
              : "On saved candles — retrying"
            : "Up to date"}
        </b>
        <span className="muted">
          {bad ? (
            <>
              {[...d!.stale, ...d!.missing].slice(0, 4).join(", ")}
              {d!.stale.length + d!.missing.length > 4 ? "…" : ""} could not be
              refreshed. It carries on with the candles it has and tries again
              {d!.nextTryAt ? ` in ${mins(d!.nextTryAt) || "under 1"} min` : " shortly"} (try{" "}
              {d!.tries + 1}); nothing needs doing.
              {d!.error && <span className="farm-why" data-why> Why: {whyWords(d!.error)}</span>}
            </>
          ) : (
            <>
              newest candle {newest} UTC · loaded {ago(farm.dataAt, now)}
              {d?.nextTryAt ? ` · next check in ${mins(d.nextTryAt)} min` : ""}
              {d?.late?.length ? (
                <span data-late title={d.lateError ? whyWords(d.lateError) : ""}>
                  {` · ${d.late.length} market${d.late.length === 1 ? "" : "s"} missed a refresh (${d.late.slice(0, 2).join(", ")}${d.late.length > 2 ? "…" : ""}); their candles are still recent`}
                </span>
              ) : null}
              {d?.hl && (
                <span data-hl={d.hl.off.length ? "partial" : "on"} title={d.hl.off.length ? `Not on Hyperliquid's prices: ${d.hl.off.join(", ")}${d.hl.error ? ` — ${d.hl.error}` : ""}` : "The recent stretch — the vault and fresh data — is Hyperliquid's own prices and funding"}>
                  {" · "}
                  {d.hl.off.length ? `Hyperliquid prices for ${d.hl.on.length} of ${d.hl.on.length + d.hl.off.length}` : "Hyperliquid prices ✓"}
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <div>
        <small>STANDING</small>
        <b>
          {int(standing)} survivor{standing === 1 ? "" : "s"}
        </b>
        <span className="muted">
          {int(L.proven ?? 0)} proven · {int(L.proving ?? 0)} proving ·{" "}
          {int(L.incubating ?? 0)} incubating · {int(farm.funnel.proof ?? 0)}{" "}
          significant
        </span>
      </div>
      <div>
        <small>SEARCH</small>
        <b>{int(farm.kinds ?? farm.entrants ?? 0)} kinds tested</b>
        <span className="muted">
          {int(farm.dupes ?? 0)} copies skipped · overfit meter{" "}
          {typeof farm.pbo === "number" ? pct(farm.pbo, 0) : "—"} ·{" "}
          {farm.cfg.coins.join(" ")}
        </span>
      </div>
    </div>
  );
}

/** the search itself: how overfit it is, how many kinds of bot it keeps, how many reached the unseen data */
function Search({ farm, explain }: { farm: FarmView; explain: boolean }) {
  const p = farm.pbo;
  const has = typeof p === "number" && Number.isFinite(p);
  const tone = !has ? "muted" : p! < 0.25 ? "up" : p! < 0.5 ? "warn" : "down";
  const word = !has
    ? "not measured yet"
    : p! < 0.25
      ? "low — the bots that train best tend to stay ahead on other data"
      : p! < 0.5
        ? "moderate — training rank carries over only partly"
        : "high — the best bot in training is no better than the rest on other data: there may be no edge to find in these coins and paces";
  return (
    <div className="farm-search" data-search>
      <div className="farm-meter" title="Probability of backtest overfitting (Bailey, Borwein, López de Prado & Zhu 2017), by combinatorially symmetric cross-validation over the latest bots that made money in training">
        <span>Overfit meter</span>
        <span className="farm-bar">
          <i className={tone} style={{ width: `${has ? Math.max(2, p! * 100) : 0}%` }} />
        </span>
        <b className={`mono ${tone}`}>{has ? pct(p!, 0) : "—"}</b>
      </div>
      <div className="lab-line">
        <span className={tone}>{word}</span>
      </div>
      <div className="lab-kv mono">
        <span>{int(farm.niches ?? 0)} niches kept</span>
        <span>{int(farm.kinds ?? 0)} kinds reached the unseen data</span>
        <span>{int(farm.dupes ?? 0)} copies skipped</span>
      </div>
      {explain && (
        <div className="lab-line muted">
          The meter cuts the training years into eight stretches and asks, for
          every way of splitting them in half: does the bot that did best on
          one half stay in the top half on the other? The share of splits where
          it does not is the reading — near 50 % or more means the search is
          fitting noise. The significance bar rises with every kind of bot
          that reaches the unseen data, so a long search cannot talk itself
          into a fluke; copies of a kind already held are skipped, so the work
          goes into new ideas.
        </div>
      )}
    </div>
  );
}

/** the blocks the farm has learned are working: it draws these more often */
function Blocks({ farm, explain }: { farm: FarmView; explain: boolean }) {
  const rows = farm.blocks ?? [];
  const KIND: Record<string, string> = {
    strategy: "Strategy",
    model: "Market model",
    join: "How rules are joined",
    risk: "Risk",
  };
  return (
    <div className="farm-wide" data-blocks>
      <table className="pro-table compact farm-blocks">
        <thead>
          <tr>
            <th className="l">BLOCK</th>
            <th className="l">KIND</th>
            <th title="Bots tried with this block">TRIED</th>
            <th title="Of those, how many trained well enough to face the gauntlet">
              FACED THE GAUNTLET
            </th>
            <th title="Of those, how many survived every check">SURVIVED</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={`${b.kind}:${b.id}`}>
              <td className="l b">{b.name}</td>
              <td className="l muted">{KIND[b.kind] ?? b.kind}</td>
              <td className="mono">{int(b.tried)}</td>
              <td className="mono">
                {int(b.passed)} · {pct(b.passed / Math.max(1, b.tried), 0)}
              </td>
              <td className={`mono ${b.survived ? "up b" : "muted"}`}>
                {int(b.survived)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {explain && (
        <div className="lab-line muted">
          The farm keeps count for every block and draws the ones that keep
          producing good bots more often. A block that has produced nothing is
          drawn less, never dropped: what fails alone may work in a combination
          not tried yet.
        </div>
      )}
    </div>
  );
}

/** the team pool: up to five teams to choose from */
function TeamPoolView({
  teams,
  explain,
  onSel,
  onMsg,
}: {
  teams: Team[];
  explain: boolean;
  onSel: (id: string) => void;
  onMsg: (m: string) => void;
}) {
  const [key, setKey] = useState<string>(teams[0].key);
  const team = teams.find((t) => t.key === key) ?? teams[0];
  return (
    <div data-team-pool>
      <div className="farm-chips farm-team-picks">
        {teams.map((t, i) => (
          <button key={t.key} className={`chip${t.key === team.key ? " active" : ""}`} onClick={() => setKey(t.key)} data-team-pick={i}>
            Team {i + 1} · Sharpe {num(t.sharpe)} · {pct(t.ret, 0)} a year{t.ready ? " · ✓ ready" : ""}
          </button>
        ))}
      </div>
      <TeamCard key={team.key} team={team} explain={explain} onSel={onSel} onMsg={onMsg} />
    </div>
  );
}

/** a team: survivors that fit together as one portfolio */
function TeamCard({
  team,
  explain,
  onSel,
  onMsg,
}: {
  team: Team;
  explain: boolean;
  onSel: (id: string) => void;
  onMsg: (m: string) => void;
}) {
  const [authority, setAuthority] = useState<Authority>("council");
  const [busy, setBusy] = useState(false);
  const deployed = useLab((s) => s.status?.deployed ?? []);
  const live = (name: string) => deployed.some((d) => d.name === name);
  const left = team.members.filter((m) => !live(m.name));
  const deployAll = async () => {
    if (!desktop?.lab || !left.length) return;
    if (
      !confirm(
        `Deploy these ${left.length} strategies to the crypto swarm?\n\n${left.map((m) => `• ${m.name}`).join("\n")}\n\nEach trades on its own; the swarm’s risk rules size every trade. You can switch any of them off under DEPL.`,
      )
    )
      return;
    setBusy(true);
    try {
      for (const m of left) {
        const built = buildSpec(m.flow);
        await desktop.lab.deploy(
          {
            spec: { ...built.spec, name: m.name },
            tfH: m.tfH,
            stats: {
              sharpe: m.oos.sharpe,
              t: m.oos.t,
              dsr: m.dsr,
              trades: m.oos.trades,
              ...testedStats(m.oos, m.tfH),
              verdict: `edge finder · team · ${m.stage}`,
            },
            authority,
          },
          { crypto: true, meme: false },
          m.coins,
        );
      }
      onMsg(
        `Deployed the team (${left.length} strateg${left.length === 1 ? "y" : "ies"}) to the crypto swarm. The edge finder watches each on fresh data in “The live fleet”.`,
      );
    } catch (e) {
      onMsg(String((e as Error)?.message ?? e));
    }
    setBusy(false);
  };
  const lift = team.solo.sharpe > 0 ? team.sharpe / team.solo.sharpe - 1 : NaN;
  return (
    <div className="farm-team" data-team>
      {team.ready && (
        <div className="lab-line up" data-ready>
          ✓ Every member is a proven edge — significant on the unseen data and proven on fresh data — and the team is strong together. With Telegram linked, it is offered on your phone with Deploy buttons.
        </div>
      )}
      <div className="farm-team-stats">
        <div>
          <small>TOGETHER · SHARPE</small>
          <b className="mono up">{num(team.sharpe)}</b>
          <span className="muted">
            best member alone {num(team.solo.sharpe)}
            {Number.isFinite(lift) ? ` (${lift >= 0 ? "+" : ""}${pct(lift, 0)})` : ""}
          </span>
        </div>
        <div>
          <small>WORST DROP</small>
          <b className="mono down">{pct(-team.maxDD)}</b>
          <span className="muted">best member alone {pct(-team.solo.maxDD)}</span>
        </div>
        <div>
          <small>A YEAR · SIZED UP</small>
          <b className={`mono ${team.ret >= 0 ? "up" : "down"}`}>{pct(sizedUp(team.ret, team.maxDD).ret, 0)}</b>
          <span className="muted">
            {pct(team.ret, 0)} at 1× · {num(sizedUp(team.ret, team.maxDD).lev, 1)}× for a {pct(-sizedUp(team.ret, team.maxDD).maxDD, 0)} worst drop
          </span>
        </div>
        <div>
          <small>MOVE TOGETHER</small>
          <b className="mono">{num(team.corr)}</b>
          <span className="muted">average correlation · {int(team.days)} days</span>
        </div>
      </div>
      <table className="pro-table compact farm-team-table">
        <thead>
          <tr>
            <th className="l">MEMBER</th>
            <th className="l">PACE</th>
            <th title="Its share of the team’s risk: inverse volatility, so each member carries the same risk">
              SHARE OF RISK
            </th>
            <th title="Its Sharpe ratio alone, on the team’s days">ALONE</th>
            <th title="Its record on fresh data: the vault and the candles since it was found">FRESH DATA</th>
            <th className="l">STAGE</th>
            <th className="l" />
          </tr>
        </thead>
        <tbody>
          {team.members.map((m) => (
            <tr key={m.id} onClick={() => onSel(m.id)} data-member={m.id}>
              <td className="l b farm-name" title={m.name}>
                {m.name.split(" · ").slice(0, 2).join(" · ")}
              </td>
              <td className="l muted">{m.pace ? m.pace[0].toUpperCase() + m.pace.slice(1) : paceOf(m.flow.style)}</td>
              <td className="mono">
                <span className="farm-share">
                  <i style={{ width: `${m.weight * 100}%` }} />
                </span>{" "}
                {pct(m.weight, 0)}
              </td>
              <td className="mono">{num(m.sharpe)}</td>
              <td className="mono">{m.fresh ? `${pct(m.fresh.ret)} · ${m.fresh.trades} trades` : "—"}</td>
              <td className={`l ${STAGE_TONE[m.stage] ?? ""}`}>
                {LADDER.find((l) => l.id === m.stage)?.name ?? m.stage}
                {m.sig ? " · significant" : ""}
              </td>
              <td className="l">
                {live(m.name) ? (
                  <span className="up">✓ deployed</span>
                ) : (
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendToBot({ block: "flow", id: "flow", from: "the edge finder", flow: m.flow, name: m.name });
                      onMsg(`Opened “${m.name}” in the bot builder (BOT).`);
                    }}
                  >
                    Open
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="farm-actions">
        <span className="muted">Who decides their trades:</span>
        <button className={`chip${authority === "council" ? " active" : ""}`} onClick={() => setAuthority("council")}>
          Council decides
        </button>
        <button className={`chip${authority === "tested" ? " active" : ""}`} onClick={() => setAuthority("tested")}>
          Trade as tested
        </button>
        <button className="btn bb2-primary farm-team-deploy" disabled={busy || !left.length} onClick={() => void deployAll()}>
          {!left.length ? "✓ The team is deployed" : `⇢ Deploy the team (${left.length})`}
        </button>
      </div>
      {explain && (
        <div className="lab-line muted">
          Strategies that make money at different times smooth each other out:
          together they earn more for the same risk than the best of them alone.
          Each team is one scalping, one intraday and one swing strategy, read
          on the days all three have results on data they were not trained on
          (the unseen stretch, the vault and the candles since). Every member
          must be in profit on those days and no two may move as one; each
          member’s share is set so all carry the same risk. The best five make
          the pool, and a team in it keeps its place unless a new one is clearly
          better — the pool is saved, so it survives restarts and reloads.
          Deploying a team is your call.
        </div>
      )}
    </div>
  );
}

function FleetView({
  fleet,
  top,
  onMsg,
}: {
  fleet: FleetItem[];
  top: Survivor[];
  onMsg: (m: string) => void;
}) {
  const replace = (f: FleetItem) => {
    const s = top.find((t) => t.id === f.replace);
    if (!s || !desktop?.lab) return;
    if (
      !confirm(
        `Replace “${f.name}” with “${s.name}” in the crypto swarm? An open trade it took stays open and is managed by the default rules.`,
      )
    )
      return;
    const built = buildSpec(s.flow);
    void desktop.lab
      .undeploy(f.id)
      .then(() =>
        desktop!.lab.deploy(
          {
            spec: { ...built.spec, name: s.name },
            tfH: s.tfH,
            stats: {
              sharpe: s.oos.sharpe,
              t: s.oos.t,
              dsr: s.dsr,
              trades: s.oos.trades,
              ...testedStats(s.oos, s.tfH),
              verdict: `edge finder · ${s.stage}`,
            },
            authority: "council",
          },
          { crypto: true, meme: false },
          s.coins,
        ),
      )
      .then(() => onMsg(`Replaced “${f.name}” with “${s.name}”.`))
      .catch((e) => onMsg(String(e?.message ?? e)));
  };
  return (
    <div className="farm-wide">
      <table className="pro-table farm-fleet">
        <thead>
          <tr>
            <th className="l">DEPLOYED</th>
            <th className="l">PACE</th>
            <th className="l">STATUS</th>
            <th>FRESH DATA</th>
            <th className="l">READING</th>
            <th className="l" />
          </tr>
        </thead>
        <tbody>
          {fleet.map((f) => (
            <tr key={f.id} data-fleet={f.status}>
              <td className="l b" title={f.name}>
                {f.name.split(" · ").slice(0, 2).join(" · ")}
              </td>
              <td className="l muted">
                {f.tfH < 1
                  ? `${Math.round(f.tfH * 60)}m`
                  : f.tfH === 24
                    ? "1d"
                    : `${f.tfH}h`}
              </td>
              <td
                className={`l b ${f.status === "healthy" ? "up" : f.status === "fading" ? "down" : f.status === "slipping" ? "warn" : "muted"}`}
              >
                {f.status}
              </td>
              <td
                className={`mono ${f.forward && f.forward.ret >= 0 ? "up" : "down"}`}
              >
                {f.forward && f.forward.trades
                  ? `${pct(f.forward.ret)} · ${f.forward.trades} tr`
                  : "—"}
              </td>
              <td className="l muted">{f.text}</td>
              <td className="l">
                {f.replace &&
                  (f.status === "fading" || f.status === "slipping") && (
                    <button className="btn" onClick={() => replace(f)}>
                      Replace with #
                      {top.findIndex((t) => t.id === f.replace) + 1}
                    </button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings({
  farm,
  busy,
  onApply,
}: {
  farm: FarmView;
  busy: boolean;
  onApply: (patch: Partial<FarmView["cfg"]>) => void;
}) {
  const [coins, setCoins] = useState(farm.cfg.coins.join(" "));
  const [styles, setStyles] = useState<StyleId[]>(farm.cfg.styles);
  const [sides, setSides] = useState(farm.cfg.sides);
  const [pace, setPace] = useState(farm.cfg.pace);
  const [maxDD, setMaxDD] = useState(farm.cfg.maxDD);
  const [hl, setHl] = useState(farm.cfg.hl !== false);
  useEffect(() => {
    setCoins(farm.cfg.coins.join(" "));
    setStyles(farm.cfg.styles);
    setSides(farm.cfg.sides);
    setPace(farm.cfg.pace);
    setMaxDD(farm.cfg.maxDD);
    setHl(farm.cfg.hl !== false);
  }, [farm.cfg]);
  const toggle = (id: StyleId) =>
    setStyles((xs) =>
      xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id],
    );
  return (
    <Popover
      label="⚙ Settings"
      title="Coins, paces, sides and speed"
      align="right"
    >
      <div className="farm-settings">
        <label>
          <span>Coins (up to 8)</span>
          <input
            className="ctl mono"
            value={coins}
            onChange={(e) => setCoins(e.target.value.toUpperCase())}
          />
        </label>
        <div>
          <span>Paces to breed (each needs its own candles)</span>
          <div className="farm-chips">
            {STYLES.map((s) => (
              <button
                key={s.id}
                className={`chip${styles.includes(s.id) ? " active" : ""}`}
                onClick={() => toggle(s.id)}
                title={s.plain}
                data-style={s.id}
              >
                {s.name.split(" — ")[0]} · {s.timeframe}
              </button>
            ))}
          </div>
        </div>
        <div className="farm-chips">
          <span>Prices</span>
          <button
            className={`chip${hl ? " active" : ""}`}
            onClick={() => setHl(true)}
            title="The years of history from Binance, with Hyperliquid's own recent candles and funding joined on: the vault and fresh data — what decides proven — are the market the swarm trades"
          >
            Hyperliquid (what the swarm trades)
          </button>
          <button className={`chip${!hl ? " active" : ""}`} onClick={() => setHl(false)} title="Binance and the other exchanges only">
            Other exchanges only
          </button>
        </div>
        <div className="farm-chips">
          <span>Direction</span>
          <button
            className={`chip${sides === "both" ? " active" : ""}`}
            onClick={() => setSides("both")}
          >
            Long and short
          </button>
          <button
            className={`chip${sides === "long" ? " active" : ""}`}
            onClick={() => setSides("long")}
          >
            Long only
          </button>
        </div>
        <div className="farm-chips">
          <span>Speed</span>
          <button
            className={`chip${pace === "gentle" ? " active" : ""}`}
            onClick={() => setPace("gentle")}
            title="Uses about half of one processor core: the terminal stays smooth"
          >
            Gentle
          </button>
          <button
            className={`chip${pace === "full" ? " active" : ""}`}
            onClick={() => setPace("full")}
            title="One processor core flat out: more bots an hour"
          >
            Full
          </button>
        </div>
        <div className="farm-chips">
          <span>Shuffle drawdown limit</span>
          {[0.15, 0.2, 0.25, 0.3].map((v) => (
            <button
              key={v}
              className={`chip${maxDD === v ? " active" : ""}`}
              onClick={() => setMaxDD(v)}
            >
              {Math.round(v * 100)} %
            </button>
          ))}
        </div>
        <button
          className="btn bb2-primary"
          disabled={busy || !styles.length}
          onClick={() => {
            onApply({
              coins: coins.split(/[\s,]+/).filter(Boolean),
              styles,
              sides,
              pace,
              maxDD,
              hl,
            });
            // the settings box closes: the results are right under it
            document.body.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true }),
            );
          }}
        >
          Apply and run
        </button>
      </div>
    </Popover>
  );
}

/** the edge finder at a glance, for the research screen */
export function FarmStrip({ onOpen }: { onOpen: () => void }) {
  useEffect(() => startLabLink(), []);
  const farm = useLab((s) => s.farm);
  if (!farm || !desktop?.lab?.farm) return null;
  return (
    <div className="farm-strip" data-farm-strip>
      <span className={`farm-dot ${farm.running ? "on" : ""}`} />
      <b>Edge finder</b>
      <span className="muted">
        {farm.running
          ? `running · ${int(farm.tried)} bots tried`
          : `stopped · ${int(farm.tried)} tried`}{" "}
        ·{" "}
        {farm.top.length
          ? `top ${farm.top.length}: ${farm.top.map((s, i) => `#${i + 1} ${s.name.split(" · ")[0]} (${pct(s.oos.cagr, 0)} a year)`).join(" · ")}`
          : "no survivor yet"}
      </span>
      <span className="grow" />
      <button className="btn" onClick={onOpen}>
        Open FARM
      </button>
    </div>
  );
}
