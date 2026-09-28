import { useId, useState, type ReactNode } from "react";
import type { FooterConfig, ThemeDef } from "../api";
import { gradientColor, uiColor } from "../colors";
import { useT, type Messages } from "../i18n";
import { useStore } from "../store";
import { termScheme, useTheme } from "../theme";
import { Icon } from "./Icon";
import { TextField } from "./TextField";

/**
 * Hover or focus a choice to see it in the preview before committing to it (the try-on never
 * saves; clicking applies). Spread the result onto the choice button.
 */
function useTryOn() {
  const setTryOn = useStore((s) => s.setTryOn);
  return (patch: Partial<FooterConfig>, label: string) => ({
    onMouseEnter: () => setTryOn({ patch, label }),
    onMouseLeave: () => setTryOn(null),
    onFocus: () => setTryOn({ patch, label }),
    onBlur: () => setTryOn(null),
  });
}

/* Six theme tokens laid out in the proportions they occupy on a real line. */
const STRIP: Array<[string, number]> = [
  ["project", 22],
  ["git", 14],
  ["accent", 14],
  ["ok", 10],
  ["warn", 10],
  ["crit", 10],
];

/** A theme's colours on the preview's terminal ground (theme colours are made for a terminal, not the panel). */
function Strip({ theme, scale = 1 }: { theme: ThemeDef | undefined; scale?: number }) {
  const ground = useTheme(termScheme);
  return (
    <span className="strip" data-scheme={ground} aria-hidden="true">
      {STRIP.map(([k, w]) => (
        <i key={k} style={{ width: w * scale, background: uiColor(theme?.tokens[k]) }} />
      ))}
    </span>
  );
}

function ThemeChoices() {
  const themes = useStore((s) => s.themes);
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  const setTryOn = useStore((s) => s.setTryOn);
  const tryOn = useTryOn();
  const current = typeof config.theme === "string" ? config.theme : "custom";
  return (
    <>
      {themes.map((th) => (
        <button
          key={th.name}
          className="choice"
          data-active={current === th.name}
          aria-pressed={current === th.name}
          {...tryOn({ theme: th.name }, th.name)}
          onClick={() => {
            setConfig((c) => {
              c.theme = th.name;
            });
            setTryOn(null);
          }}
        >
          <Strip theme={th} />
          {th.name}
        </button>
      ))}
    </>
  );
}

/* Bar glyph pairs; each one is shown exactly as the statusline will draw it. Names live in `bars.names`. */
const BAR_SETS: Array<{ id: keyof Messages["bars"]["names"]; filled: string; empty: string }> = [
  { id: "theme", filled: "", empty: "" },
  { id: "block", filled: "█", empty: "░" },
  { id: "rect", filled: "▮", empty: "▯" },
  { id: "low", filled: "▆", empty: "▁" },
  { id: "half", filled: "▄", empty: "▁" },
  { id: "slant", filled: "▰", empty: "▱" },
  { id: "square", filled: "■", empty: "□" },
  { id: "line", filled: "━", empty: "╌" },
  { id: "dot", filled: "●", empty: "○" },
];
const drawBar = (f: string, e: string) => f.repeat(4) + e.repeat(6);

/** The bar style in effect: a named set, the theme's own ("theme"), or hand-edited glyphs ("custom"). */
function useBarState() {
  const config = useStore((s) => s.config)!;
  const themes = useStore((s) => s.themes);
  const themeBar = (typeof config.theme === "string" ? themes.find((th) => th.name === config.theme)?.bar : config.theme.bar) ?? { filled: "█", empty: "░" };
  const named = BAR_SETS.find((b) => b.id !== "theme" && config.bar?.filled === b.filled && config.bar?.empty === b.empty)?.id;
  const current: (typeof BAR_SETS)[number]["id"] | "custom" = named ?? (config.bar ? "custom" : "theme");
  const glyphs = config.bar ?? themeBar;
  return { themeBar, current, glyphs };
}

function BarChoices() {
  const t = useT();
  const setConfig = useStore((s) => s.setConfig);
  const setTryOn = useStore((s) => s.setTryOn);
  const tryOn = useTryOn();
  const { themeBar, current } = useBarState();
  return (
    <>
      {BAR_SETS.map((b) => (
        <button
          key={b.id}
          className="choice"
          data-active={current === b.id}
          aria-pressed={current === b.id}
          // "Theme default" previews as the theme's own glyphs: patch them in explicitly.
          {...tryOn({ bar: b.id === "theme" ? themeBar : { filled: b.filled, empty: b.empty } }, t.bars.names[b.id])}
          onClick={() => {
            setConfig((c) => {
              if (b.id === "theme") delete c.bar;
              else c.bar = { filled: b.filled, empty: b.empty };
            });
            setTryOn(null);
          }}
        >
          <span className="mono glyphs">{b.id === "theme" ? drawBar(themeBar.filled, themeBar.empty) : drawBar(b.filled, b.empty)}</span>
          <small>{t.bars.names[b.id]}</small>
        </button>
      ))}
    </>
  );
}

type LevelMode = FooterConfig["colorMode"];
const LEVEL_MODES: LevelMode[] = ["thresholds", "gradient"];
/* Cells in a level swatch. Under thresholds, at the default 70/85: six green, two yellow, two red. */
const LEVEL_CELLS = 10;

/**
 * A full bar in the user's own filled glyph, each cell coloured as `mode` colours that percentage:
 * the swatch is the mode's whole range at a glance. Drawn on the preview's terminal ground, like the
 * theme strip, because these colours are made for a terminal.
 */
function LevelSample({ mode, theme, filled }: { mode: LevelMode; theme: ThemeDef | undefined; filled: string }) {
  const ground = useTheme(termScheme);
  const tokens = theme?.tokens ?? {};
  const cells = Array.from({ length: LEVEL_CELLS }, (_, i) => {
    if (mode === "gradient") return gradientColor((i * 100) / (LEVEL_CELLS - 1));
    // The same test as api.level() with the widgets' usual thresholds, 70 and 85.
    const pct = ((i + 1) * 100) / LEVEL_CELLS;
    return uiColor(tokens[pct >= 85 ? "crit" : pct >= 70 ? "warn" : "ok"]);
  });
  return (
    <span className="level-sample mono glyphs" data-scheme={ground} aria-hidden="true">
      {cells.map((c, i) => (
        <span key={i} style={{ color: c }}>
          {filled}
        </span>
      ))}
    </span>
  );
}

function LevelChoices({ theme, filled }: { theme: ThemeDef | undefined; filled: string }) {
  const t = useT();
  const mode = useStore((s) => s.config!.colorMode);
  const setConfig = useStore((s) => s.setConfig);
  const setTryOn = useStore((s) => s.setTryOn);
  const tryOn = useTryOn();
  return (
    <>
      {LEVEL_MODES.map((m) => (
        <button
          key={m}
          className="choice"
          data-active={mode === m}
          aria-pressed={mode === m}
          title={t.levels.hints[m]}
          {...tryOn({ colorMode: m }, t.levels.names[m])}
          onClick={() => {
            setConfig((c) => {
              c.colorMode = m;
            });
            setTryOn(null);
          }}
        >
          <LevelSample mode={m} theme={theme} filled={filled} />
          <small>{t.levels.names[m]}</small>
        </button>
      ))}
    </>
  );
}

/** Common separators. Each chip shows it between two words so the spacing is visible. */
const SEPARATORS = [" │ ", " · ", " • ", " / ", " | ", " ❯ ", "  "];
/** Spaces are invisible in a text field; ␣ makes a leading/trailing/double space readable. */
const showSpaces = (s: string) => s.replace(/ /g, "␣");

function SeparatorChoices() {
  const t = useT();
  const sep = useStore((s) => s.config!.separator);
  const setConfig = useStore((s) => s.setConfig);
  const setTryOn = useStore((s) => s.setTryOn);
  const tryOn = useTryOn();
  const custom = !SEPARATORS.includes(sep);
  const set = (v: string) => {
    setConfig((c) => {
      c.separator = v;
    });
    setTryOn(null);
  };
  return (
    <>
      {SEPARATORS.map((v) => (
        <button key={v} className="choice" data-active={sep === v} aria-pressed={sep === v} {...tryOn({ separator: v }, showSpaces(v))} onClick={() => set(v)} aria-label={showSpaces(v)}>
          <span className="mono sep-sample">
            main<b>{v}</b>42%
          </span>
        </button>
      ))}
      <span className="choice choice-custom" data-active={custom}>
        {/* Empty unless the value really is custom: a preset like " │ " in a text box reads as an empty field with a caret. */}
        <TextField className="field mono !w-28" value={custom ? sep : ""} onChange={(v) => setConfig((c) => void (c.separator = v))} ariaLabel={t.separators.customLabel} placeholder={t.separators.custom} />
        {custom && (
          <span className="mono hint" title={t.separators.spacesShown}>
            {showSpaces(sep)}
          </span>
        )}
      </span>
    </>
  );
}

/** Common placeholders for a widget with no data; "" = hide it (the default). Anything else goes in Custom. */
const EMPTY_TEXTS = ["", "–", "-", "…", "?", "n/a"];

/** Style → Empty widgets: config `emptyText`, what a labelled widget prints before it has data. */
function EmptyTextChoices() {
  const t = useT();
  const value = useStore((s) => s.config!.emptyText ?? "");
  const setConfig = useStore((s) => s.setConfig);
  const setTryOn = useStore((s) => s.setTryOn);
  const tryOn = useTryOn();
  const custom = !EMPTY_TEXTS.includes(value);
  const set = (v: string) => {
    setConfig((c) => {
      c.emptyText = v;
    });
    setTryOn(null);
  };
  return (
    <>
      {EMPTY_TEXTS.map((v) => (
        <button key={v} className="choice" data-active={value === v} aria-pressed={value === v} {...tryOn({ emptyText: v }, v || t.emptyText.hide)} onClick={() => set(v)} aria-label={v || t.emptyText.hide}>
          {v ? (
            <span className="mono sep-sample">
              {t.emptyText.sampleLabel} <b>{v}</b>
            </span>
          ) : (
            <span>{t.emptyText.hide}</span>
          )}
        </button>
      ))}
      <span className="choice choice-custom" data-active={custom}>
        <TextField className="field mono !w-28" value={custom ? value : ""} onChange={(v) => setConfig((c) => void (c.emptyText = v))} ariaLabel={t.emptyText.customLabel} placeholder={t.separators.custom} />
      </span>
    </>
  );
}

type Part = "theme" | "bar" | "levels" | "separator" | "empty";

/**
 * How the statusline looks, as one row of summaries — the current theme, bar glyphs, progress bar
 * mode, separator and empty-widget placeholder — each opening its choices in place underneath. It used to lay out all 24 choices at once; most
 * visits change none of them, and the one that does only needs one group at a time.
 */
export function Style() {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState<Part | null>(null);
  const config = useStore((s) => s.config)!;
  const themes = useStore((s) => s.themes);
  const setTryOn = useStore((s) => s.setTryOn);
  const { current: barId, glyphs } = useBarState();
  const themeName = typeof config.theme === "string" ? config.theme : t.style.customTheme;
  const theme = typeof config.theme === "string" ? themes.find((th) => th.name === config.theme) : config.theme;

  const toggle = (p: Part) => {
    setTryOn(null);
    setOpen(open === p ? null : p);
  };
  const pick = (p: Part, label: string, summary: ReactNode) => (
    <button className="style-pick" aria-expanded={open === p} aria-controls={open === p ? panelId : undefined} onClick={() => toggle(p)}>
      <span className="style-pick-label">{label}</span>
      {summary}
      <Icon name="chevron" size={12} className="style-pick-chevron" />
    </button>
  );
  const titles: Record<Part, string> = { theme: t.themes.title, bar: t.bars.title, levels: t.levels.title, separator: t.separators.title, empty: t.emptyText.title };
  const emptyText = config.emptyText ?? "";

  return (
    <section className="section" aria-labelledby="style-title">
      <div className="section-head">
        <h2 id="style-title" className="h2">
          {t.style.title}
        </h2>
      </div>
      <div className="style-picks">
        {pick("theme", t.themes.title, <><Strip theme={theme} scale={0.6} /><span>{themeName}</span></>)}
        {pick("bar", t.bars.title, <><span className="mono glyphs">{drawBar(glyphs.filled, glyphs.empty)}</span><span>{barId === "custom" ? t.separators.custom : t.bars.names[barId]}</span></>)}
        {pick("levels", t.levels.title, <><LevelSample mode={config.colorMode} theme={theme} filled={glyphs.filled} /><span>{t.levels.names[config.colorMode]}</span></>)}
        {pick(
          "separator",
          t.separators.title,
          <span className="mono sep-sample">
            main<b>{config.separator}</b>42%
          </span>,
        )}
        {pick(
          "empty",
          t.emptyText.title,
          emptyText ? (
            <span className="mono sep-sample">
              {t.emptyText.sampleLabel} <b>{emptyText}</b>
            </span>
          ) : (
            <span>{t.emptyText.hide}</span>
          ),
        )}
      </div>
      {open && (
        <div
          id={panelId}
          className="style-panel"
          role="group"
          aria-label={titles[open]}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setTryOn(null);
              setOpen(null);
            }
          }}
        >
          <p className="hint">{open === "empty" ? t.emptyText.hint : t.style.hint}</p>
          <div className="choices">
            {open === "theme" && <ThemeChoices />}
            {open === "bar" && <BarChoices />}
            {open === "levels" && <LevelChoices theme={theme} filled={glyphs.filled} />}
            {open === "separator" && <SeparatorChoices />}
            {open === "empty" && <EmptyTextChoices />}
          </div>
        </div>
      )}
    </section>
  );
}
