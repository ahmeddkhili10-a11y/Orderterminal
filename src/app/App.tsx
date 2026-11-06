import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Actions, DockLocation, ICloseType, Layout, Model, type BorderNode, type IJsonModel, type ILayoutApi, type ITabSetRenderValues, type TabNode, type TabSetNode } from 'flexlayout-react';
import { canPopOut, popOut } from '../pro/Screens';
import 'flexlayout-react/style/dark.css';
import { startAlerts, useToasts } from '../alerts/engine';
import { startAmtService } from '../desktop/amt';
import { startLunoAlerts } from '../luno/lane';
import { startBotAlerts } from '../desktop/botAlerts';
import { startCryptoSwarmLink } from '../cswarm/store';
import { CommandCenter } from '../command/CommandCenter';
import { startTelegramService } from '../desktop/telegram';
import { startCollectors } from '../market/collectors';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { applyTheme } from '../ui/theme';
import { loadLayout, loadProLayout, PRESETS, PRO_LAYOUTS, sanitize, saveLayout, saveProLayout, tab } from './layouts';
import { CommandBar, openFunction, StatusLine, switchUi } from '../pro/ProBar';
import type { FnHome, Workspace } from '../pro/functions';
import { startLabLink } from '../lab/store';
import { AddPanelModal, ConnectionModal, LayoutsModal, SettingsModal, type Placement } from './Modals';
import { KeysModal } from './KeysModal';
import { PanelHost } from './PanelHost';
import { TopBar, type ModalKind } from './TopBar';

export function useThemeAttr() {
  const theme = useSettings((s) => s.theme);
  const filter = useSettings((s) => s.filter);
  const glass = useSettings((s) => s.glass);
  useLayoutEffect(() => applyTheme(theme, filter, glass), [theme, filter, glass]);
}

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          <b>{t.title}</b>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

const WS: Workspace[] = ['markets', 'lab', 'quant'];

/** ⧉ on each tab bar: pop the selected panel out into its own window (desktop) */
function popButton(m: Model) {
  return (node: TabSetNode | BorderNode, rv: ITabSetRenderValues) => {
    const sel = node.getSelectedNode() as TabNode | undefined;
    const comp = sel?.getComponent();
    if (!sel || !comp || !canPopOut(comp)) return;
    rv.buttons.push(
      <button
        key="popout"
        className="flexlayout__tab_toolbar_button pop-out-btn"
        title="Pop out into its own window — then send it to any screen (Screens)"
        onClick={() =>
          void popOut(comp, sel.getName(), (sel.getConfig() ?? {}) as Record<string, unknown>).then((id) => {
            if (id !== null) m.doAction(Actions.deleteTab(sel.getId()));
          })
        }
      >
        ⧉
      </button>,
    );
  };
}

export function App() {
  useThemeAttr();
  const [classicModel, setClassicModel] = useState(() => Model.fromJson(loadLayout()));
  const [proModels, setProModels] = useState(() => Object.fromEntries(WS.map((w) => [w, Model.fromJson(loadProLayout(w))])) as Record<Workspace, Model>);
  const [modal, setModal] = useState<ModalKind>(null);
  const layoutRef = useRef<ILayoutApi>(null);
  const proRefs = useRef<Partial<Record<Workspace, ILayoutApi | null>>>({});
  const fired = useSettings((s) => s.fired);
  const ui = useSettings((s) => s.ui);
  const pro = ui === 'pro';
  // the crypto swarm's own view: apart from the terminal; the terminal's workspaces stay mounted behind it
  const swarm = ui === 'swarm';
  const proLike = pro || swarm;
  const ws = useSettings((s) => s.workspace);
  // a workspace's layout is mounted the first time it is opened, then kept (its charts keep their state)
  const [visited, setVisited] = useState<Set<Workspace>>(() => new Set([ws]));
  useEffect(() => setVisited((v) => (v.has(ws) ? v : new Set([...v, ws]))), [ws]);
  const model = pro ? proModels[ws] : classicModel;
  const layoutApi = () => (pro ? (proRefs.current[ws] ?? null) : layoutRef.current);
  const sessionStart = useMemo(() => Date.now(), []);

  useEffect(() => {
    hub();
    startCollectors();
    startAlerts();
    startTelegramService();
    startAmtService();
    startLunoAlerts();
    startBotAlerts();
    startCryptoSwarmLink();
    startLabLink();
  }, []);

  // the command line and the function keys open a panel in its workspace
  useEffect(() => {
    const open = (e: Event) => {
      const { panel, ws: target } = (e as CustomEvent<{ panel: string; ws: FnHome }>).detail;
      const st = useSettings.getState();
      // the crypto swarm's tools open in its own view
      if (target === 'swarm') {
        openFunction(panel, 'swarm');
        return;
      }
      if (st.ui === 'classic') {
        openPanel(panel);
        return;
      }
      if (st.ui === 'swarm') switchUi('pro');
      if (st.workspace !== target) st.set({ workspace: target });
      showIn(proModels[target], panel);
    };
    window.addEventListener('novus:open-panel', open);
    return () => window.removeEventListener('novus:open-panel', open);
  });

  // the crypto swarm tab puts its panel in the layout if it is missing (never twice)
  useEffect(() => {
    const ensure = (e: Event) => {
      const component = (e as CustomEvent<string>).detail;
      let found = false;
      model.visitNodes((n) => {
        if (n.getType() === 'tab' && (n as TabNode).getComponent() === component) found = true;
      });
      if (!found) addPanel(component, 'right');
    };
    window.addEventListener('novus:ensure-panel', ensure);
    return () => window.removeEventListener('novus:ensure-panel', ensure);
  });
  // Ctrl+1 the terminal, Ctrl+2 the crypto swarm
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key === '1' || e.key === '2') {
        e.preventDefault();
        switchUi(e.key === '1' ? 'pro' : 'swarm');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // panels ask for the Connections window through a window event
  useEffect(() => {
    const open = () => setModal('keys');
    window.addEventListener('novus:connect', open);
    return () => window.removeEventListener('novus:connect', open);
  }, []);

  const applyLayout = useCallback(
    (json: IJsonModel) => {
      const m = Model.fromJson(sanitize(json));
      if (pro) {
        saveProLayout(ws, m.toJson());
        setProModels((all) => ({ ...all, [ws]: m }));
      } else {
        saveLayout(m.toJson());
        setClassicModel(m);
      }
    },
    [pro, ws],
  );

  // outside edit mode tabs can't be dragged or docked (no accidental
  // rearranging); every panel can always be closed with its ×, and the gaps
  // between panels always stay resizable
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const on = editing;
    for (const m of [classicModel, ...Object.values(proModels)]) m.doAction(Actions.updateModelAttributes({ tabEnableDrag: on, tabSetEnableDrag: on, tabSetEnableDrop: on, tabEnableClose: true, tabCloseType: ICloseType.Always, tabSetEnableDivide: on }));
  }, [classicModel, proModels, editing]);

  /** Maximise (or restore) the tabset holding the main chart. */
  const focusChart = useCallback(() => {
    let target: string | undefined;
    for (const comp of ['footprint', 'historical', 'heatmap'])
      model.visitNodes((n) => {
        if (!target && n.getType() === 'tab' && (n as TabNode).getComponent() === comp) target = n.getParent()?.getId();
      });
    if (target) model.doAction(Actions.maximizeToggle(target));
  }, [model]);

  /** Add a panel to the active area, a new column/row at an edge, or a dock edge. */
  const addPanel = (id: string, where: Placement = 'active') => {
    const json = tab(id);
    const l = layoutApi();
    if (!l) return;
    const edge = { left: DockLocation.LEFT, right: DockLocation.RIGHT, bottom: DockLocation.BOTTOM } as const;
    if (where === 'left' || where === 'right' || where === 'bottom') {
      model.doAction(Actions.addNode(json, model.getRootRow()!.getId(), edge[where], -1, true));
      return;
    }
    if (where.startsWith('dock-')) {
      const loc = edge[where.slice(5) as keyof typeof edge];
      let border: BorderNode | undefined;
      model.visitNodes((n) => {
        if (!border && n.getType() === 'border' && (n as BorderNode).getLocation() === loc) border = n as BorderNode;
      });
      if (border) {
        model.doAction(Actions.addNode(json, border.getId(), DockLocation.CENTER, -1, true));
        return;
      }
    }
    if (!l.addTabToActiveTabSet(json)) {
      const first = model.getFirstTabSet();
      if (first) l.addTabToTabSet(first.getId(), json);
    }
  };

  /** Show a panel in a workspace's model: select its tab, or add it to the active (or first) tab set. */
  const showIn = (m: Model, component: string) => {
    let found: string | undefined;
    m.visitNodes((n) => {
      if (!found && n.getType() === 'tab' && (n as TabNode).getComponent() === component) found = n.getId();
    });
    if (found) {
      m.doAction(Actions.selectTab(found));
      return;
    }
    const target = m.getActiveTabset() ?? m.getFirstTabSet();
    if (target) m.doAction(Actions.addNode(tab(component), target.getId(), DockLocation.CENTER, -1, true));
    else m.doAction(Actions.addNode(tab(component), m.getRootRow()!.getId(), DockLocation.RIGHT, -1, true));
  };

  /** Show a panel: select its tab if it is already in the layout, otherwise add it as a new column. */
  const openPanel = (component: string) => {
    let found: string | undefined;
    model.visitNodes((n) => {
      if (!found && n.getType() === 'tab' && (n as TabNode).getComponent() === component) found = n.getId();
    });
    if (found) model.doAction(Actions.selectTab(found));
    else addPanel(component, 'right');
  };

  const factory = useCallback((node: TabNode) => <PanelHost node={node} model={model} />, [model]);
  const proFactories = useMemo(() => Object.fromEntries(WS.map((w) => [w, (node: TabNode) => <PanelHost node={node} model={proModels[w]} />])) as Record<Workspace, (n: TabNode) => ReactElement>, [proModels]);

  return (
    <div className={`app${editing ? ' editing' : ''}${pro ? ' pro' : ''}`}>
      <div className="app-bg" aria-hidden>
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
      </div>
      <TopBar onOpen={setModal} onFocusChart={focusChart} onOpenPanel={openPanel} alertCount={fired.filter((f) => f.time >= sessionStart).length} editing={editing} onEdit={() => setEditing(!editing)} />
      {pro && <CommandBar />}
      {editing && (
        <div className="edit-bar" role="region" aria-label="Layout editing">
          <b>✎ Editing layout</b>
          <span className="tips" title="Drag a panel by its tab: drop it on the middle of another panel to stack them, or on a highlighted edge to split. Drag the gaps between panels to resize. × on a tab closes it; double-click a tab bar to maximise.">
            <kbd>drag a tab</kbd> move · drop on an edge to split · <kbd>drag a gap</kbd> resize · <kbd>×</kbd> close · <kbd>double-click</kbd> tab bar to maximise
          </span>
          <button className="btn ghost" onClick={() => setModal('add')}>
            + Add panel
          </button>
          <button className="btn ghost" onClick={() => setModal('layouts')}>
            ▦ Layouts
          </button>
          <button className="btn ghost" onClick={() => confirm('Reset to the default layout? Your current arrangement is replaced (save it in Layouts first if you want to keep it).') && applyLayout(pro ? PRO_LAYOUTS[ws]() : PRESETS[0].build())}>
            Reset
          </button>
          <button className="btn" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
      {swarm && <CommandCenter />}
      {ui === 'classic' && (
        <div className="layout-host">
          <div className="layout-inner">
            <Layout ref={layoutRef} model={classicModel} factory={factory} onModelChange={(m) => saveLayout(m.toJson())} onRenderTabSet={popButton(classicModel)} realtimeResize />
          </div>
        </div>
      )}
      {proLike &&
        WS.filter((w) => visited.has(w)).map((w) => (
          <div key={w} className="layout-host pro-host" data-ws={w} style={pro && w === ws ? undefined : { display: 'none' }}>
            <div className="layout-inner">
              <Layout ref={(r) => void (proRefs.current[w] = r)} model={proModels[w]} factory={proFactories[w]} onModelChange={(m) => saveProLayout(w, m.toJson())} onRenderTabSet={popButton(proModels[w])} realtimeResize />
            </div>
          </div>
        ))}
      {pro && <StatusLine />}
      {modal === 'connection' && <ConnectionModal onClose={() => setModal(null)} />}
      {modal === 'layouts' && <LayoutsModal onClose={() => setModal(null)} onApply={applyLayout} current={() => model.toJson()} />}
      {modal === 'add' && <AddPanelModal onClose={() => setModal(null)} onAdd={addPanel} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'keys' && <KeysModal onClose={() => setModal(null)} onOpenPanel={openPanel} />}
      <Toasts />
    </div>
  );
}
