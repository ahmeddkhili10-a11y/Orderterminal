// HELP: every function code, by workspace, and the keys.
import { FUNCTIONS, WORKSPACES } from './functions';
import { openFunction } from './ProBar';

export function ProHelp() {
  return (
    <div className="pro-panel">
      <div className="pro-scroll">
        <div className="lab-line">
          Type a code on the command line and press <b>Enter</b> (or click it here). A coin first makes it the market: <span className="mono">ETH GP</span>, <span className="mono">SOL BOOK</span>. <b>F1–F4</b> switch workspaces; <b>Ctrl+K</b> or <b>`</b> jumps to the command line. Every panel can be popped out to its own window and sent to another screen with ⧉ on its tab bar.
        </div>
        {WORKSPACES.map((w) => (
          <div key={w.id}>
            <div className="pro-section">
              {w.key} · {w.name} — {w.desc}
            </div>
            <table className="pro-table compact">
              <tbody>
                {FUNCTIONS.filter((f) => f.ws === w.id).map((f) => (
                  <tr key={f.code} onClick={() => openFunction(f.panel, f.ws)}>
                    <td className="l mono b pro-code">{f.code}</td>
                    <td className="l b">{f.name}</td>
                    <td className="l muted">{f.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
