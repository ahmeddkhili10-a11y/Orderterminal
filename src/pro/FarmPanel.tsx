// FARM — the edge finder: a strategy farm that runs by itself while the
// terminal is open. Bots are bred from the bot builder's blocks, trained on
// the first 70 % of the history, and must survive the unseen 30 %, 100 random
// bots, their settings nudged, 1,000 shuffles and a significance test. The
// survivors are forward-tested on fresh data; the best five are here, ready to
// open in the bot builder or deploy to the crypto swarm — the user's call.
import { useEffect, useMemo, useState } from "react";
import { desktop, type FarmView } from "../desktop/bridge";
import { sendToBot } from "../lab/bridge";
import { LADDER, STAGES, type FleetItem, type Survivor } from "../lab/farm";
import { buildSpec, STYLE_MAP, STYLES, type StyleId } from "../lab/flow";
import { startLabLink, useLab, type Authority } from "../lab/store";
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
}
export const FARM_PANEL_DEFAULTS: FarmConfig = { explain: true };

export function FarmPanel({ config: c, setConfig }: PanelProps<FarmConfig>) {
  useEffect(() => startLabLink(), []);
  const farm = useLab((s) => s.farm);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
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
  const all = [...farm.top, ...farm.watch];
  const pick =
    all.find((s) => s.id === sel) ?? farm.top[0] ?? farm.watch[0] ?? null;
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
        {c.explain && (
          <div className="farm-intro">
            Every bot is treated as curve-fitted until it proves it is not. The
            edge finder breeds bots from the bot builder’s blocks — the Strategy
            Lab’s rules and the Quant desk’s models — trains each on the first
            70 % of the history, and keeps it only if it survives every check
            below. It runs by itself while the terminal is open; the best five
            that are still standing are listed here for you to open, test and
            deploy.
          </div>
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
                Survivors keep being tested on candles that arrive after they
                were found — data no test has seen. Those that keep making money
                climb to proven; those that fade are dropped from the top five.
              </div>
            )}
            <div className="lab-line mono muted">
              newest candle{" "}
              {farm.dataTo
                ? new Date(farm.dataTo)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ")
                : "—"}{" "}
              UTC · data loaded {ago(farm.dataAt, now)} ·{" "}
              {farm.cfg.coins.join(" ")} ·{" "}
              {farm.cfg.styles.map(paceOf).join(", ")}
            </div>
          </div>
        </div>

        <div className="pro-section">
          TOP 5 — THE BEST STILL STANDING{farm.top.length ? "" : " (NONE YET)"}
        </div>
        {farm.top.length ? (
          <Table rows={farm.top} sel={pick?.id ?? null} onSel={setSel} />
        ) : (
          <div className="lab-note">
            {running || starting
              ? "No bot has survived every check yet. That is the point: most ideas do not hold up on data they never saw. Leave it running — it keeps breeding and testing in the background, and a strategy appears here the moment one earns it."
              : "Nothing has survived every check yet. Press Start and leave it running while you use the terminal."}
          </div>
        )}
        {farm.watch.length > 0 && (
          <>
            <div className="pro-section">
              WATCH LIST — PASSED THE FOUR CHECKS, NOT YET SIGNIFICANT;
              FORWARD-TESTING
            </div>
            <Table
              rows={farm.watch}
              sel={pick?.id ?? null}
              onSel={setSel}
              watch
            />
          </>
        )}
        {pick && (
          <Detail
            key={pick.id}
            s={pick}
            rank={farm.top.indexOf(pick) + 1}
            onMsg={setMsg}
            explain={c.explain}
          />
        )}

        {farm.fleet.length > 0 && (
          <>
            <div className="pro-section">
              THE LIVE FLEET — YOUR DEPLOYED STRATEGIES ON FRESH DATA
            </div>
            <Fleet fleet={farm.fleet} top={farm.top} onMsg={setMsg} />
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
                    : r.why.startsWith("passed the four")
                      ? "watch list"
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

function Table({
  rows,
  sel,
  onSel,
  watch,
}: {
  rows: Survivor[];
  sel: string | null;
  onSel: (id: string) => void;
  watch?: boolean;
}) {
  return (
    <div className="farm-wide">
      <table className={`pro-table farm-table${watch ? " watch" : ""}`}>
        <thead>
          <tr>
            <th className="l">#</th>
            <th className="l">STRATEGY</th>
            <th className="l">PACE</th>
            <th title="A year’s return on the unseen 30 %">A YEAR</th>
            <th title="Return for the risk on the unseen 30 %">SHARPE</th>
            <th title="The biggest fall from a high on the unseen 30 %">
              WORST DROP
            </th>
            <th title="Share of months (or weeks) that made money on the unseen 30 %">
              MONTHS UP
            </th>
            <th title="Random bots it beat, of 100">RANDOM</th>
            <th title="Nudged versions of its settings that still made money">
              NUDGES
            </th>
            <th title="The unlucky 1-in-20 drawdown of 1,000 shuffles, at 1 % risk a trade">
              SHUFFLE
            </th>
            <th title="Since it was found: on candles no test has seen">
              FRESH DATA
            </th>
            <th className="l">STAGE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr
              key={s.id}
              className={sel === s.id ? "sel" : ""}
              onClick={() => onSel(s.id)}
              data-survivor={s.id}
            >
              <td className="l b">{watch ? "·" : i + 1}</td>
              <td className="l farm-name" title={s.name}>
                {s.name.split(" · ").slice(0, 2).join(" · ")}
              </td>
              <td className="l muted">{paceOf(s.style)}</td>
              <td className={`mono b ${s.oos.cagr >= 0 ? "up" : "down"}`}>
                {pct(s.oos.cagr, 0)}
              </td>
              <td className="mono">{num(s.oos.sharpe)}</td>
              <td className="mono down">{pct(-s.oos.maxDD)}</td>
              <td className="mono">{pct(s.periods.up, 0)}</td>
              <td className="mono">{s.beat}/100</td>
              <td className="mono">
                {s.nudge.kept}/{s.nudge.tried}
              </td>
              <td className="mono">{pct(s.mc.dd95, 0)}</td>
              <td
                className={`mono ${s.forward && s.forward.trades ? (s.forward.ret >= 0 ? "up" : "down") : "muted"}`}
              >
                {s.forward && s.forward.trades
                  ? `${pct(s.forward.ret)} · ${s.forward.trades} tr`
                  : "waiting"}
              </td>
              <td className={`l ${STAGE_TONE[s.stage] ?? ""}`}>
                {LADDER.find((l) => l.id === s.stage)?.name ?? s.stage}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({
  s,
  rank,
  onMsg,
  explain,
}: {
  s: Survivor;
  rank: number;
  onMsg: (m: string) => void;
  explain: boolean;
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
      value: `t = ${num(s.oos.t)} (needs 2) · chance it is real after ${int(s.tried)} bots tried: ${pct(s.dsr, 0)}`,
      pass: s.sig,
    },
    {
      name: "Fresh data",
      value:
        s.forward && s.forward.trades
          ? `${pct(s.forward.ret)} over ${s.forward.trades} trades in ${num(s.forward.days, 0)} days (Sharpe ${num(s.forward.sharpe)})`
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
        {rank > 0 ? `#${rank} — ` : "WATCH LIST — "}
        {s.name.toUpperCase()}
      </div>
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

function Fleet({
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
  useEffect(() => {
    setCoins(farm.cfg.coins.join(" "));
    setStyles(farm.cfg.styles);
    setSides(farm.cfg.sides);
    setPace(farm.cfg.pace);
    setMaxDD(farm.cfg.maxDD);
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
            title="Uses about a third of one processor core: the terminal stays smooth"
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
          onClick={() =>
            onApply({
              coins: coins.split(/[\s,]+/).filter(Boolean),
              styles,
              sides,
              pace,
              maxDD,
            })
          }
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
