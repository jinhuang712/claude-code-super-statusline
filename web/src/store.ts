import { create } from "zustand";
import { tr, widgetName } from "./i18n";
import { applyEdits } from "./layers";
import {
  api,
  NeedsConfirm,
  type ConfigLayer,
  type EffectiveConfig,
  type FooterConfig,
  type InstallPlan,
  type LineConfig,
  type RenderResult,
  type SampleMeta,
  type ThemeDef,
  type WidgetInstance,
  type WidgetManifest,
  type Zone,
} from "./api";

export interface Selection {
  line: number;
  zone: Zone;
  index: number;
}

export type PresetId = "minimal" | "standard" | "full";
/** Which config file edits are written to. */
export type Scope = "user" | "project";

/** Preset layouts. Names and blurbs are UI copy and live in the locale files (`presets.<id>`). */
export const PRESETS: Record<PresetId, { lines: LineConfig[] }> = {
  // Context usage without its bar prints what context.value did (`ctx 32%`); that widget is no
  // longer offered, so the preset doesn't hand out one the tray won't.
  minimal: {
    lines: [{ left: [{ widget: "project.path" }, { widget: "git.branch" }], right: [{ widget: "model.badge" }, { widget: "context.bar", label: "ctx", options: { showBar: false } }] }],
  },
  standard: {
    lines: [
      { left: [{ widget: "project.path" }, { widget: "git.branch" }], right: [{ widget: "model.badge" }] },
      { left: [{ widget: "usage.windows" }], right: [{ widget: "context.bar" }] },
    ],
  },
  // A layout built and tuned in the panel, taken as is — labels, bold and options included, so the
  // preset looks like the layout it was made from. (matchingPreset compares widgets only.)
  full: {
    lines: [
      {
        left: [
          { widget: "project.path", label: "Project", options: { levels: "tilde" } },
          { widget: "project.sessionName", label: null, style: { bold: true } },
        ],
        right: [{ widget: "model.badge", label: null, options: { effortParens: true, effortStyle: "word" } }],
      },
      {
        left: [
          { widget: "git.repo", label: "Git" },
          { widget: "git.branch", options: { showFileStats: true } },
          { widget: "git.linesChanged", style: { bold: true }, options: { source: "worktree" } },
        ],
        right: [{ widget: "context.bar", options: { showTokens: true } }],
      },
      {
        left: [{ widget: "usage.windows", options: { resetFormat: "absolute", bar: true } }],
        right: [{ widget: "context.promptCache", options: { showHitRatio: true } }],
      },
      {
        left: [{ widget: "cost.session" }, { widget: "tokens.session", options: { style: "arrows" } }],
        right: [{ widget: "tokens.outputSpeed" }],
      },
    ],
  },
};

interface State {
  loading: boolean;
  error: string | null;
  /** The effective config being edited (defaults ← user ← project). */
  config: FooterConfig | null;
  /** The effective config as of the last load/save; edits are the diff from here (see layers.ts). */
  saved: FooterConfig | null;
  layers: ConfigLayer[];
  paths: EffectiveConfig["paths"] | null;
  /** Where edits are saved. Defaults to the project file when the previewed project has one. */
  scope: Scope;
  /**
   * The project the panel is looking at: the previewed live session's directory, or null for the
   * directory the server was started in. Drives the project layer and project-scope saves.
   */
  projectCwd: string | null;
  sandbox: boolean;
  /** Running as the site's demo: no Claude Code behind the page, so actions that need one are hidden. */
  demo: boolean;
  widgets: WidgetManifest[];
  themes: ThemeDef[];
  samples: SampleMeta[];
  sampleId: string | null;
  columns: number;
  /** "auto" follows the preview's width; a number pins the column count to match a real terminal. */
  columnsMode: "auto" | number;
  preview: RenderResult | null;
  /** The column count the current preview was rendered for; the terminal only redraws when it matches. */
  previewColumns: number;
  selection: Selection | null;
  toast: string | null;
  saving: boolean;
  /** Last save failure, shown in the header until a save succeeds (a toast alone is too easy to miss). */
  saveError: string | null;
  installed: boolean | null;
  /** What settings.json holds now and what install would write; refreshed after every install/uninstall. */
  installPlan: InstallPlan | null;
  /**
   * Set when applying would replace another tool's statusLine (claude-hud, a custom script…). The
   * header asks before anything is overwritten; "Not now" stops asking for this page view.
   */
  consent: { current: unknown } | null;
  consentDismissed: boolean;
  /** Where keyboard focus should land after a keyboard move; the chip rendered there claims it. */
  focusPos: Selection | null;
  /** Latest screen-reader announcement (rendered into an aria-live region). */
  live: string;
  /**
   * A look being tried on (hover/focus on a preset, theme or bar style): merged over the config for
   * the preview only — never saved. `label` names it in the preview toolbar.
   */
  tryOn: { patch: Partial<FooterConfig>; label: string } | null;
  /**
   * The viewer picked "Custom" explicitly, so the editor stays open even when the lines happen to
   * match a preset. Otherwise the mode follows the lines (see layoutMode).
   */
  customMode: boolean;
  /** The lines last edited in Custom mode, kept (this page view only) while a preset is on. */
  lastCustom: LineConfig[] | null;

  init(): Promise<void>;
  /**
   * Apply an edit. There is no undo, on purpose: it was dropped as more noise than help (every
   * removal came with a "Ctrl/⌘+Z to undo" toast). Edits save on their own, 800 ms later.
   */
  setConfig(mutate: (c: FooterConfig) => void): void;
  setScope(scope: Scope): void;
  setColumns(n: number): void;
  setColumnsMode(m: "auto" | number): void;
  select(sel: Selection | null): void;
  /** Close the open options panel and give focus back to the chip it belongs to. */
  closeOptions(): void;
  /**
   * Insert a widget (from the tray) at a position — the end of the zone when `index` is omitted;
   * with no lines at all, a first line is created. Focus moves to the new chip.
   */
  addWidget(line: number, zone: Zone, widget: string, index?: number): void;
  removeAt(sel: Selection): void;
  moveWidget(from: Selection, toLine: number, toZone: Zone, toIndex?: number): void;
  reorder(line: number, zone: Zone, from: number, to: number): void;
  addLine(): void;
  removeLine(i: number): void;
  moveLine(i: number, dir: -1 | 1): void;
  updateAt(sel: Selection, mutate: (w: WidgetInstance) => void): void;
  applyPreset(id: PresetId): void;
  /**
   * Pick the layout mode: a preset replaces the lines (the custom ones are remembered), "custom"
   * opens the editor — on the remembered custom lines when coming back from a preset.
   */
  chooseLayout(mode: PresetId | "custom"): void;
  /** Save pending edits to the current scope. `autoApply: false` skips the first-save install step. */
  saveNow(opts?: { autoApply?: boolean }): Promise<void>;
  /** Snapshot the current look into the previewed project's own config file and edit that from now on. */
  saveAsProject(): Promise<void>;
  /** Let a project's own widgets load (written to the *user* file; a project can't trust itself). */
  trustProject(root: string): Promise<void>;
  /** Apply to Claude Code; `confirmReplace` is the user's explicit yes to replacing another statusLine. */
  install(confirmReplace?: boolean): Promise<void>;
  /** Stop using this statusline: restores the one it replaced, or removes ours. */
  uninstall(): Promise<void>;
  /** Retime Claude Code's statusline refresh (seconds; null = only on session events). */
  setRefreshInterval(seconds: number | null): Promise<void>;
  dismissConsent(): void;
  resetCounters(): Promise<void>;
  refreshPreview(): Promise<void>;
  /** Keyboard move: one step within the zone, across to the neighbouring zone at an edge, or to the line above/below. */
  nudge(sel: Selection, dir: "left" | "right" | "up" | "down"): void;
  claimFocus(): void;
  /** Preview a patch without applying it; null goes back to the real config. */
  setTryOn(t: { patch: Partial<FooterConfig>; label: string } | null): void;
  notify(msg: string | null): void;
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** localStorage can throw (blocked storage, private mode); per-viewer prefs just fall back. */
function pref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered; still applies for this page view */
  }
}

export function zoneOf(line: LineConfig, zone: Zone): WidgetInstance[] {
  if (!line[zone]) line[zone] = [];
  return line[zone]!;
}

/**
 * The Claude Code session this page belongs to: /super-statusline:config opens it with `?session=<id>` (the id
 * Claude Code exports to the slash command's shell). Null when the page was opened some other way.
 */
function sessionFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("session");
  } catch {
    return null; // no window (tests) or a malformed URL: behave as if opened directly
  }
}

/**
 * What the preview shows — there is no picker: the session /super-statusline:config was run from; if it hasn't
 * rendered (and so been captured) yet, the most recent live session; with none at all, the first
 * bundled sample. The server lists live samples newest first.
 */
function pickSample(samples: SampleMeta[], session: string | null): string | null {
  const live = samples.filter((s) => s.source === "live");
  return (session ? live.find((s) => s.sessionId === session) : undefined)?.id ?? live[0]?.id ?? samples[0]?.id ?? null;
}

/** The directory a sample's session ran in, when it is a live one. */
function cwdOf(samples: SampleMeta[], id: string | null): string | null {
  const s = samples.find((x) => x.id === id);
  return s?.source === "live" ? (s.cwd ?? null) : null;
}

/** Edit the project file when the project has one — its values override the user file's. */
function defaultScope(layers: ConfigLayer[]): Scope {
  return layers.some((l) => l.name === "project" && l.exists) ? "project" : "user";
}

export const useStore = create<State>((set, get) => {
  /** Adopt a freshly loaded effective config (after init, a save, or switching project). */
  const adopt = (eff: EffectiveConfig, opts: { keepEdits?: boolean; resetScope?: boolean } = {}) =>
    set({
      saved: structuredClone(eff.config),
      layers: eff.layers,
      paths: eff.paths,
      ...(opts.keepEdits ? {} : { config: eff.config }),
      ...(opts.resetScope ? { scope: defaultScope(eff.layers) } : {}),
    });

  const schedulePreview = (ms: number) => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void get().refreshPreview(), ms);
  };
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveNow(), 800);
  };

  return {
    loading: true,
    error: null,
    config: null,
    saved: null,
    layers: [],
    paths: null,
    scope: "user",
    projectCwd: null,
    sandbox: false,
    demo: false,
    widgets: [],
    themes: [],
    samples: [],
    sampleId: null,
    columns: Number(pref("ssp.columns") ?? 120),
    columnsMode: pref("ssp.columnsMode") === null || pref("ssp.columnsMode") === "auto" ? "auto" : Number(pref("ssp.columnsMode")),
    preview: null,
    previewColumns: 0,
    selection: null,
    toast: null,
    saving: false,
    saveError: null,
    installed: null,
    installPlan: null,
    consent: null,
    consentDismissed: false,
    focusPos: null,
    live: "",
    tryOn: null,
    customMode: false,
    lastCustom: null,

    async init() {
      try {
        const [widgets, themes, samples, plan, health] = await Promise.all([
          api.widgets(),
          api.themes(),
          api.samples(),
          api.installPlan().catch(() => null),
          api.health().catch(() => null),
        ]);
        const sampleId = pickSample(samples, sessionFromUrl());
        const projectCwd = cwdOf(samples, sampleId);
        // The effective config depends on the project, so it loads after we know which one.
        const eff = await api.config(projectCwd).catch(() => api.config());
        set({ widgets, themes, samples, sampleId, projectCwd, sandbox: health?.sandbox === true, demo: health?.demo === true, installed: plan ? plan.currentIsOurs : null, installPlan: plan, loading: false });
        adopt(eff, { resetScope: true });
        void get().refreshPreview();
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    setConfig(mutate) {
      const before = get().config!;
      const c = structuredClone(before);
      mutate(c);
      if (JSON.stringify(c) === JSON.stringify(before)) return;
      set({ config: c });
      schedulePreview(120);
      scheduleSave();
    },

    setScope(scope) {
      set({ scope });
    },

    setColumns(n) {
      if (n === get().columns) return;
      setPref("ssp.columns", String(n));
      set({ columns: n });
      schedulePreview(80);
    },

    setColumnsMode(m) {
      setPref("ssp.columnsMode", String(m));
      set({ columnsMode: m });
      if (typeof m === "number") get().setColumns(m);
    },

    select: (selection) => set({ selection }),
    closeOptions: () => set((st) => ({ selection: null, focusPos: st.selection })),

    addWidget(line, zone, widget, index) {
      const lines = get().config!.lines;
      const l = lines.length === 0 ? 0 : Math.max(0, Math.min(line, lines.length - 1));
      const len = lines[l]?.[zone]?.length ?? 0;
      const pos: Selection = { line: l, zone, index: index === undefined ? len : Math.max(0, Math.min(index, len)) };
      get().setConfig((c) => {
        if (c.lines.length === 0) c.lines.push({ left: [], right: [] });
        zoneOf(c.lines[pos.line]!, zone).splice(pos.index, 0, { widget });
      });
      // Not selected (that would open its options on every add); focus goes to the new chip so
      // Alt+Arrow places it and Enter edits it — the tray item it came from may just have vanished.
      const t = tr();
      const name = widgetName(t, get().widgets.find((w) => w.id === widget), widget);
      set({ focusPos: pos, live: t.tray.added(name, pos.line + 1) });
    },

    removeAt(sel) {
      get().setConfig((c) => {
        zoneOf(c.lines[sel.line]!, sel.zone).splice(sel.index, 1);
      });
      set({ selection: null });
    },

    moveWidget(from, toLine, toZone, toIndex) {
      get().setConfig((c) => {
        const [item] = zoneOf(c.lines[from.line]!, from.zone).splice(from.index, 1);
        if (!item) return;
        const target = zoneOf(c.lines[toLine]!, toZone);
        target.splice(toIndex ?? target.length, 0, item);
      });
      set({ selection: null });
    },

    reorder(line, zone, from, to) {
      if (from === to) return;
      get().setConfig((c) => {
        const arr = zoneOf(c.lines[line]!, zone);
        const [item] = arr.splice(from, 1);
        if (item) arr.splice(to, 0, item);
      });
    },

    addLine() {
      get().setConfig((c) => {
        c.lines.push({ left: [], right: [] });
      });
    },

    removeLine(i) {
      get().setConfig((c) => {
        c.lines.splice(i, 1);
      });
      set({ selection: null });
    },

    moveLine(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= get().config!.lines.length) return;
      get().setConfig((c) => {
        const [l] = c.lines.splice(i, 1);
        if (l) c.lines.splice(j, 0, l);
      });
      set({ selection: null });
    },

    updateAt(sel, mutate) {
      get().setConfig((c) => {
        const w = zoneOf(c.lines[sel.line]!, sel.zone)[sel.index];
        if (w) mutate(w);
      });
    },

    applyPreset(id) {
      get().setConfig((c) => {
        c.lines = structuredClone(PRESETS[id].lines);
      });
      set({ selection: null });
    },

    chooseLayout(mode) {
      const s = get();
      const current = layoutMode(s);
      if (mode === "custom") {
        // Back from a preset: bring the custom lines back.
        if (current !== "custom" && s.lastCustom) {
          const lines = structuredClone(s.lastCustom);
          s.setConfig((c) => {
            c.lines = lines;
          });
        }
        set({ customMode: true });
        return;
      }
      if (current === mode) return;
      // Leaving Custom for a preset: remember what was built there.
      if (current === "custom") set({ lastCustom: structuredClone(s.config!.lines) });
      set({ customMode: false });
      s.applyPreset(mode);
    },

    async saveNow(opts = {}) {
      const { config: c, saved, scope, layers, projectCwd } = get();
      if (!c) return;
      const snapshot = JSON.stringify(c);
      const layer = layers.find((l) => l.name === scope)?.value ?? {};
      set({ saving: true });
      try {
        await api.saveConfig(applyEdits(layer, saved, c) as Partial<FooterConfig>, scope, projectCwd);
        const eff = await api.config(projectCwd);
        // Adopt the server's normalized shape so "dirty" compares like with like — unless the user kept editing meanwhile.
        adopt(eff, { keepEdits: JSON.stringify(get().config) !== snapshot });
        set({ saving: false, saveError: null });
        // `render` re-reads the config file on every tick, but Claude Code only runs it when
        // settings.json points at us — so the first successful save auto-applies, *unless* that
        // would replace someone else's statusLine: then the header asks first (see `consent`).
        // The demo has no Claude Code to apply to.
        if (opts.autoApply !== false && get().installed !== true && !get().demo) {
          const plan = get().installPlan;
          const foreign = plan !== null && plan.current !== null && plan.current !== undefined && !plan.currentIsOurs;
          if (foreign) {
            if (!get().consentDismissed) set({ consent: { current: plan.current } });
          } else {
            try {
              await api.install(false);
              set({ installed: true, installPlan: await api.installPlan().catch(() => plan) });
            } catch (err) {
              // The server is the final judge: it may see a foreign statusLine the stale plan missed.
              if (err instanceof NeedsConfirm && !get().consentDismissed) set({ consent: { current: err.current } });
              /* other failures: the manual button stays as a fallback and the next save retries */
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ saving: false, saveError: msg, toast: tr().toast.saveFailed(msg) });
      }
    },

    async saveAsProject() {
      const { config: c, layers, projectCwd } = get();
      if (!c) return;
      // The visual choices, merged over whatever the project file already had.
      const project = layers.find((l) => l.name === "project")?.value ?? {};
      const next = { ...project, lines: c.lines, theme: c.theme, separator: c.separator, colorLevel: c.colorLevel, ...(c.bar ? { bar: c.bar } : {}) };
      try {
        await api.saveConfig(next as Partial<FooterConfig>, "project", projectCwd);
        adopt(await api.config(projectCwd));
        set({ scope: "project", saveError: null, toast: tr().toast.savedProject });
      } catch (err) {
        set({ toast: tr().toast.saveFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    async trustProject(root) {
      const { layers, projectCwd } = get();
      const user = (layers.find((l) => l.name === "user")?.value ?? {}) as Partial<FooterConfig>;
      const trusted = [...new Set([...(user.plugins?.trustedProjects ?? []), root])];
      const next = { ...user, plugins: { dirs: user.plugins?.dirs ?? [], ...user.plugins, trustedProjects: trusted } };
      try {
        await api.saveConfig(next, "user", projectCwd);
        adopt(await api.config(projectCwd), { keepEdits: true });
        set({ toast: tr().toast.trusted(root) });
      } catch (err) {
        set({ toast: tr().toast.saveFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    async install(confirmReplace = false) {
      try {
        await get().saveNow({ autoApply: false });
        const r = await api.install(confirmReplace);
        set({ installed: true, consent: null, installPlan: await api.installPlan().catch(() => get().installPlan), toast: tr().toast.installed(r.settingsFile) });
      } catch (err) {
        if (err instanceof NeedsConfirm) set({ consent: { current: err.current }, consentDismissed: false });
        else set({ toast: tr().toast.installFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    async uninstall() {
      try {
        const r = await api.uninstall();
        set({ installed: false, installPlan: await api.installPlan().catch(() => null), toast: r.restored ? tr().toast.restored : tr().toast.uninstalled });
      } catch (err) {
        set({ toast: tr().toast.uninstallFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    async setRefreshInterval(seconds) {
      try {
        await api.setRefreshInterval(seconds);
        // The menu reads the current value from the plan, so reload it rather than patching it locally.
        set({ installPlan: await api.installPlan().catch(() => get().installPlan), toast: seconds === null ? tr().toast.refreshOff : tr().toast.refreshSet(seconds) });
      } catch (err) {
        set({ toast: tr().toast.refreshFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    dismissConsent: () => set({ consent: null, consentDismissed: true }),

    async resetCounters() {
      // Reset the session being previewed when it is a live one; otherwise the most recent live one.
      const { samples, sampleId } = get();
      const live = samples.find((x) => x.id === sampleId && x.source === "live") ?? samples.find((x) => x.source === "live");
      try {
        const r = await api.reset(live?.id);
        set({ toast: tr().toast.reset(r.sessionId.slice(0, 8)) });
        void get().refreshPreview();
      } catch (err) {
        set({ toast: tr().toast.resetFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    async refreshPreview() {
      const { config, sampleId, columns, tryOn } = get();
      if (!config) return;
      try {
        const preview = await api.render(tryOn ? { ...config, ...tryOn.patch } : config, sampleId, columns);
        // A newer request is on its way (width changed, or the try-on started/ended meanwhile).
        if (get().columns !== columns || get().tryOn !== tryOn) return;
        set({ preview, previewColumns: columns });
      } catch (err) {
        set({ toast: tr().toast.previewFailed(err instanceof Error ? err.message : String(err)) });
      }
    },

    nudge(sel, dir) {
      const c = get().config!;
      const line = c.lines[sel.line];
      if (!line) return;
      const zones: Zone[] = hasCenter(get()) ? ["left", "center", "right"] : ["left", "right"];
      const len = (l: LineConfig | undefined, z: Zone) => l?.[z]?.length ?? 0;
      let to: Selection | null = null;
      if (dir === "left" || dir === "right") {
        const d = dir === "left" ? -1 : 1;
        const i = sel.index + d;
        if (i >= 0 && i < len(line, sel.zone)) to = { ...sel, index: i };
        else {
          // At the edge of a zone: hop into the neighbouring zone, entering from the near side.
          const z = zones[zones.indexOf(sel.zone) + d];
          if (z) to = { line: sel.line, zone: z, index: d < 0 ? len(line, z) : 0 };
        }
      } else {
        const l = sel.line + (dir === "up" ? -1 : 1);
        if (l >= 0 && l < c.lines.length) to = { line: l, zone: sel.zone, index: Math.min(sel.index, len(c.lines[l], sel.zone)) };
      }
      if (!to) return;
      const target = to;
      const id = line[sel.zone]?.[sel.index]?.widget ?? "";
      get().setConfig((cc) => {
        const [item] = zoneOf(cc.lines[sel.line]!, sel.zone).splice(sel.index, 1);
        if (item) zoneOf(cc.lines[target.line]!, target.zone).splice(target.index, 0, item);
      });
      const t = tr();
      const name = widgetName(t, get().widgets.find((w) => w.id === id), id);
      set({ selection: null, focusPos: target, live: t.layout.moved(name, target.line + 1, t.layout.zones[target.zone], target.index + 1) });
    },

    claimFocus: () => set({ focusPos: null }),

    setTryOn(t) {
      if (t === null && get().tryOn === null) return;
      set({ tryOn: t });
      // Short debounce: sweeping the pointer across a row of choices shouldn't fire a render per chip.
      schedulePreview(t ? 60 : 0);
    },

    notify: (toast) => set({ toast }),
  };
});

/** A layout's shape (which widgets, in which zone, in which order), ignoring empty zones and per-widget options. */
function shapeOf(lines: LineConfig[]): string {
  return lines.map((l) => (["left", "center", "right"] as const).map((z) => (l[z] ?? []).map((w) => w.widget).join(",")).join("|")).join("\n");
}

/** The preset the lines match, if any. */
export function matchingPreset(lines: LineConfig[]): PresetId | null {
  const shape = shapeOf(lines);
  return (Object.keys(PRESETS) as PresetId[]).find((id) => shapeOf(PRESETS[id].lines) === shape) ?? null;
}

/** Which layout mode is on: "custom" when chosen explicitly or when the lines match no preset. */
export function layoutMode(state: Pick<State, "customMode" | "config">): PresetId | "custom" {
  if (state.customMode || !state.config) return "custom";
  return matchingPreset(state.config.lines) ?? "custom";
}

/**
 * The center zone is only shown while some line uses it. The engine still renders `center`, but
 * the editor no longer offers it for new widgets: a centred statusline segment is rare, and the
 * opt-in toggle cost every visitor a control. Configs that already use it stay fully editable.
 */
export function hasCenter(state: Pick<State, "config">): boolean {
  return state.config?.lines.some((l) => (l.center?.length ?? 0) > 0) ?? false;
}

export function widgetAt(state: State, sel: Selection | null): WidgetInstance | null {
  if (!sel || !state.config) return null;
  return state.config.lines[sel.line]?.[sel.zone]?.[sel.index] ?? null;
}

export function isDirty(state: State): boolean {
  return JSON.stringify(state.config) !== JSON.stringify(state.saved);
}

/** Does this widget's own schema know about a label (so it has a built-in default)? */
export function ownsLabel(w: WidgetManifest | undefined): boolean {
  return Boolean(w?.schema.properties && "label" in w.schema.properties);
}

/**
 * The label the engine will actually print: the instance override wins, then the widget's default.
 * null means hidden / none. Older configs kept the override in options.label; that still counts.
 */
export function effectiveLabel(inst: WidgetInstance, w: WidgetManifest | undefined): string | null {
  const override = inst.label !== undefined ? inst.label : (inst.options?.label as string | null | undefined);
  if (override !== undefined) return override === "" ? null : override;
  if (ownsLabel(w)) {
    const d = w!.defaults.label;
    return typeof d === "string" && d !== "" ? d : null;
  }
  return null;
}

/** null = has real data; "filled" = sample text stands in; "hidden" = nothing to show at all. */
export function emptyStateAt(preview: RenderResult | null, sel: Selection): null | "filled" | "hidden" {
  const e = preview?.empty?.find((x) => x.line === sel.line && x.zone === sel.zone && x.index === sel.index);
  return e ? (e.filled ? "filled" : "hidden") : null;
}
