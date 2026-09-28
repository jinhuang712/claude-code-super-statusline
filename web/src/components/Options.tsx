import { useEffect, useId, useRef } from "react";
import type { FooterConfig, JsonSchema, Style, WidgetInstance } from "../api";
import { uiColor } from "../colors";
import { enumLabel, fieldTitle, useT, widgetDesc, widgetName } from "../i18n";
import { useProbe } from "../probe";
import { effectiveLabel, ownsLabel, useStore, widgetAt, type Selection } from "../store";
import { Ansi } from "./Ansi";
import { Icon } from "./Icon";
import { TextField } from "./TextField";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function typeOf(schema: JsonSchema) {
  const t = Array.isArray(schema.type) ? schema.type : [schema.type ?? "string"];
  return { base: t.find((x) => x !== "null") ?? "string", nullable: t.includes("null") };
}

/**
 * Why an option currently has no effect: the first unmet requirement as a sentence, or null when it
 * applies. Sibling options come from the schema's `x-requires` (e.g. cacheGlyph needs style =
 * arrows); top-level config keys from `x-requires-config` (warnAt needs the thresholds colour mode,
 * which is set under Style, so the sentence names that control).
 */
function unmetRequirement(t: ReturnType<typeof useT>, ctx: FieldCtx, schema: JsonSchema): string | null {
  const req = schema["x-requires"];
  if (req && typeof req === "object") {
    for (const [k, want] of Object.entries(req as Record<string, unknown>)) {
      const cur = ctx.inst.options?.[k] !== undefined ? ctx.inst.options[k] : ctx.defaults[k];
      if (cur === want) continue;
      // Just the value's name: an enum label may carry an explanation after a colon (see EnumField).
      const valueLabel = typeof want === "boolean" ? (want ? t.options.on : t.options.off) : enumLabel(t, ctx.inst.widget, k, String(want)).split(/[:：]/)[0]!.trim();
      return t.options.needs(fieldTitle(t, k, ctx.props[k] ?? {}), valueLabel);
    }
  }
  const creq = schema["x-requires-config"];
  if (creq && typeof creq === "object") {
    for (const [k, want] of Object.entries(creq as Record<string, unknown>)) {
      if ((ctx.config as unknown as Record<string, unknown>)[k] === want) continue;
      // colorMode is the only key widgets require today; any other is named as it is spelled.
      if (k === "colorMode") return t.options.needs(t.levels.title, t.levels.names[want as "thresholds" | "gradient"] ?? String(want));
      return t.options.needs(k, String(want));
    }
  }
  return null;
}


/** Theme tokens offered as colors, in display order; their labels live in `options.colors`. */
const TOKENS = ["", "fg", "muted", "accent", "ok", "warn", "crit"];

/** Colour as a row of swatches; each one's name is its tooltip and accessible name. */
function ColorField({ style, setStyle }: { style: Style; setStyle: (p: Partial<Style>) => void }) {
  const t = useT();
  const titleId = useId();
  const themes = useStore((s) => s.themes);
  const theme = useStore((s) => s.config?.theme);
  const tokens = typeof theme === "string" ? themes.find((th) => th.name === theme)?.tokens : theme?.tokens;
  const fg = style.fg ?? "";
  const custom = fg !== "" && !TOKENS.includes(fg);
  return (
    <div className="opt-field">
      <span className="opt-title" id={titleId}>
        {t.options.color}
      </span>
      <div className="swatches" role="radiogroup" aria-labelledby={titleId}>
        {TOKENS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={fg === k}
            aria-label={t.options.colors[k]}
            title={t.options.colors[k]}
            className="swatch"
            data-active={fg === k}
            data-none={k === ""}
            style={{ ["--sw" as string]: k ? uiColor(tokens?.[k]) : "transparent" }}
            onClick={() => setStyle({ fg: k || undefined })}
          />
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          aria-label={t.options.custom}
          title={t.options.custom}
          className="swatch"
          data-active={custom}
          data-none={!custom}
          style={{ ["--sw" as string]: custom ? fg : "transparent" }}
          onClick={() => !custom && setStyle({ fg: "#ffffff" })}
        >
          {!custom && <Icon name="plus" size={12} />}
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(fg) ? fg : "#ffffff"} onChange={(e) => setStyle({ fg: e.target.value })} aria-label={t.options.pickColor} />
          <TextField className="field field-sm mono !w-28" value={fg} onChange={(v) => setStyle({ fg: v })} placeholder="#rrggbb" ariaLabel={t.options.pickColor} />
        </div>
      )}
    </div>
  );
}

type SetOption = (name: string, v: unknown) => void;

interface FieldCtx {
  inst: WidgetInstance;
  sel: Selection;
  defaults: Record<string, unknown>;
  props: Record<string, JsonSchema>;
  setOption: SetOption;
  /** The config being edited, for options that depend on a top-level key (x-requires-config). */
  config: FooterConfig;
}

/** The value an option has right now: the instance's own, else the widget default, else the schema's. */
function current(ctx: FieldCtx, name: string): unknown {
  const v = ctx.inst.options?.[name];
  if (v !== undefined) return v;
  return ctx.defaults[name] !== undefined ? ctx.defaults[name] : ctx.props[name]?.default;
}

/**
 * An enum as a row of choices. Hovering one does nothing to the preview on purpose: a statusline
 * that changed under the pointer while reading the options was more distracting than useful, and a
 * click is instant.
 */
function EnumField({ ctx, name }: { ctx: FieldCtx; name: string }) {
  const t = useT();
  const titleId = useId();
  const schema = ctx.props[name]!;
  const title = fieldTitle(t, name, schema);
  const hint = t.widgets.fieldHints[name];
  const cur = String(current(ctx, name) ?? "");
  return (
    <div className="opt-field">
      <span className="opt-title" id={titleId} title={hint}>
        {title}
      </span>
      <div className="pills" role="radiogroup" aria-labelledby={titleId}>
        {(schema.enum ?? []).map((v) => {
          const k = String(v);
          const label = enumLabel(t, ctx.inst.widget, name, k);
          // Some values carry an explanation after a colon ("Gradient: 0% grey → … → 100% deep red").
          // As a button that wrapped to three lines, so the button shows the name and the tooltip the rest.
          const short = label.split(/[:：]/)[0]!.trim();
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={cur === k}
              className="pill"
              title={short !== label ? label : undefined}
              onClick={() => ctx.setOption(name, v)}
            >
              {short}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Every on/off option of the widget — plus Bold, which is a style rather than an option but reads
 * the same — as one group of toggle buttons, instead of a checkbox row each.
 */
function TogglesField({ ctx, names, bold, setBold }: { ctx: FieldCtx; names: string[]; bold: boolean; setBold: (b: boolean) => void }) {
  const t = useT();
  const titleId = useId();
  return (
    <div className="opt-field opt-full">
      <span className="opt-title" id={titleId}>
        {t.options.toggles}
      </span>
      <div className="pills" role="group" aria-labelledby={titleId}>
        {names.map((name) => {
          const on = Boolean(current(ctx, name));
          const title = fieldTitle(t, name, ctx.props[name]!);
          const needs = unmetRequirement(t, ctx, ctx.props[name]!);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              className="pill"
              data-inactive={needs !== null}
              title={needs ?? undefined}
              onClick={() => ctx.setOption(name, !on)}
            >
              {title}
            </button>
          );
        })}
        <button type="button" aria-pressed={bold} className="pill" onClick={() => setBold(!bold)}>
          {t.options.bold}
        </button>
      </div>
    </div>
  );
}

/**
 * warnAt + critAt as one band: green up to the first, yellow up to the second, red after. Each
 * number follows its own requirement: under the gradient (Style → Progress bar mode) warnAt does nothing (dimmed),
 * while critAt usually still bolds the value — so the band, which describes threshold colours,
 * only shows while those colours apply.
 */
function ThresholdField({ ctx }: { ctx: FieldCtx }) {
  const t = useT();
  const warnId = useId();
  const critId = useId();
  const warn = Number(current(ctx, "warnAt") ?? 70);
  const crit = Number(current(ctx, "critAt") ?? 85);
  const lo = Math.max(0, Math.min(100, Math.min(warn, crit)));
  const hi = Math.max(lo, Math.min(100, Math.max(warn, crit)));
  const warnNeeds = unmetRequirement(t, ctx, ctx.props.warnAt!);
  const critNeeds = unmetRequirement(t, ctx, ctx.props.critAt!);
  const num = (id: string, name: "warnAt" | "critAt", value: number) => (
    <input
      id={id}
      className="field field-sm mono !w-16"
      type="number"
      min={0}
      max={100}
      value={value}
      onChange={(e) => e.target.value !== "" && ctx.setOption(name, Number(e.target.value))}
    />
  );
  const bothOff = warnNeeds !== null && critNeeds !== null;
  // One reason line: for the whole field when neither number applies, else for the one that doesn't.
  const note = bothOff ? warnNeeds : warnNeeds !== null ? `${t.options.warnAt}: ${warnNeeds}` : critNeeds !== null ? `${t.options.critAt}: ${critNeeds}` : null;
  return (
    <div className="opt-field opt-full" data-inactive={bothOff}>
      <span className="opt-title">{t.options.thresholds}</span>
      <div className="threshold">
        {warnNeeds === null && (
          <span className="threshold-band" aria-hidden="true">
            <i style={{ width: `${lo}%`, background: "var(--ok)" }} />
            <i style={{ width: `${hi - lo}%`, background: "var(--warn)" }} />
            <i style={{ width: `${100 - hi}%`, background: "var(--danger)" }} />
          </span>
        )}
        {/* Each label stays with its number when the row wraps on a phone. */}
        <span className="threshold-num" data-inactive={!bothOff && warnNeeds !== null}>
          <label htmlFor={warnId} className="hint">
            {t.options.warnAt}
          </label>
          {num(warnId, "warnAt", warn)}
        </span>
        <span className="threshold-num" data-inactive={!bothOff && critNeeds !== null}>
          <label htmlFor={critId} className="hint">
            {warnNeeds !== null && critNeeds === null ? t.options.critBold : t.options.critAt}
          </label>
          {num(critId, "critAt", crit)}
        </span>
      </div>
      {note && <span className="hint needs">{note}</span>}
    </div>
  );
}

/** Numbers and free text: a labelled field; a nullable text option can also be hidden. */
function ValueField({ ctx, name }: { ctx: FieldCtx; name: string }) {
  const t = useT();
  const id = useId();
  const schema = ctx.props[name]!;
  const { base, nullable } = typeOf(schema);
  const title = fieldTitle(t, name, schema);
  const value = current(ctx, name);
  const needs = unmetRequirement(t, ctx, schema);
  return (
    <div className="opt-field" data-inactive={needs !== null}>
      <label className="opt-title" htmlFor={id}>
        {title}
      </label>
      {base === "integer" || base === "number" ? (
        <input
          id={id}
          className="field field-sm mono !w-24"
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          value={value === null || value === undefined ? "" : Number(value)}
          onChange={(e) => ctx.setOption(name, e.target.value === "" ? (nullable ? null : schema.default) : Number(e.target.value))}
        />
      ) : (
        <span className="flex items-center gap-1.5">
          <TextField
            id={id}
            className="field field-sm mono"
            disabled={value === null}
            value={value === null || value === undefined ? "" : String(value)}
            placeholder={value === null ? t.options.hidden : ""}
            onChange={(v) => ctx.setOption(name, v)}
          />
          {nullable && (
            <button className="btn btn-sm" onClick={() => ctx.setOption(name, value === null ? (schema.default ?? "") : null)}>
              {value === null ? t.options.show : t.options.hide}
            </button>
          )}
        </span>
      )}
      {needs && <span className="hint needs">{needs}</span>}
    </div>
  );
}

/**
 * A widget's options, opened in place under its line (the line and its panel read as one card).
 * It replaced a side drawer that dimmed the page and felt detached from the chip it edited.
 *
 * Keyboard: focus moves to the first control on open; Esc (anywhere inside) or Done closes and
 * returns focus to the chip.
 */
export function OptionsPanel() {
  const t = useT();
  const s = useStore();
  const labelId = useId();
  const emptyId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const sel = s.selection!;
  const w = widgetAt(s, sel)!;
  const live = useProbe([w]);
  const manifest = s.widgets.find((m) => m.id === w.widget);
  const props = manifest?.schema.properties ?? {};
  const defaults = manifest?.defaults ?? {};
  const names = Object.keys(props).filter((n) => n !== "label");

  useEffect(() => {
    // The first field, not the first control: that would be "Remove", a destructive button.
    panel.current?.querySelector<HTMLElement>(`.opt-grid :is(${FOCUSABLE})`)?.focus();
    // Re-run only when a different widget is opened, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.line, sel.zone, sel.index]);

  const setOption: SetOption = (name, v) =>
    s.updateAt(sel, (inst) => {
      inst.options = { ...(inst.options ?? {}), [name]: v };
      if (v === (defaults[name] ?? props[name]?.default)) delete inst.options[name];
      if (Object.keys(inst.options).length === 0) delete inst.options;
    });
  const ctx: FieldCtx = { inst: w, sel, defaults, props, setOption, config: s.config! };

  const style: Style = w.style ?? {};
  const setStyle = (patch: Partial<Style>) =>
    s.updateAt(sel, (inst) => {
      const next: Style = { ...(inst.style ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof Style)[]) if (!next[k]) delete next[k];
      if (Object.keys(next).length) inst.style = next;
      else delete inst.style;
    });
  const label = effectiveLabel(w, manifest);
  const defaultLabel = ownsLabel(manifest) && typeof manifest!.defaults.label === "string" ? (manifest!.defaults.label as string) : "";
  const setLabel = (v: string | null | undefined) =>
    s.updateAt(sel, (inst) => {
      if (inst.options && "label" in inst.options) {
        delete inst.options.label;
        if (Object.keys(inst.options).length === 0) delete inst.options;
      }
      if (v === undefined) delete inst.label;
      else inst.label = v;
    });
  // This widget's emptyText: undefined follows the config-wide one, null hides it when empty. An
  // own "" means "hide" to the engine too, but the field never writes it: clearing the field goes
  // back to following the global, which is what an empty box looks like it does.
  const ownEmpty = w.emptyText === "" ? null : w.emptyText;
  const globalEmpty = s.config!.emptyText ?? "";
  const setEmpty = (v: string | null | undefined) =>
    s.updateAt(sel, (inst) => {
      if (v === undefined) delete inst.emptyText;
      else inst.emptyText = v;
    });

  // Group the schema by control kind so the panel reads left to right, short controls first.
  const isThreshold = "warnAt" in props && "critAt" in props;
  const toggles = names.filter((n) => typeOf(props[n]!).base === "boolean" && !props[n]!.enum);
  const enums = names.filter((n) => props[n]!.enum);
  const values = names.filter((n) => !props[n]!.enum && typeOf(props[n]!).base !== "boolean" && !(isThreshold && (n === "warnAt" || n === "critAt")));
  const name = widgetName(t, manifest, w.widget);

  return (
    <div
      ref={panel}
      className="opt-panel"
      role="group"
      aria-label={t.options.dialog(name)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          s.closeOptions();
        }
      }}
    >
      <div className="opt-head">
        <div className="opt-id">
          <h3 className="opt-name">{name}</h3>
          <span className="hint">
            {t.options.where(sel.line + 1, t.layout.zones[sel.zone])} · {widgetDesc(t, manifest, w.widget)}
          </span>
        </div>
        <div className="opt-actions">
          <button className="btn btn-ghost btn-danger" onClick={() => s.removeAt(sel)}>
            {t.options.removeWidget}
          </button>
          <button className="btn" onClick={() => s.closeOptions()}>
            {t.options.done}
          </button>
        </div>
      </div>
      {/* What it prints right now, with the current data (the preview above shows it in context). */}
      <div className="opt-live">{live[0] === undefined ? "…" : <Ansi text={live[0]} fallback={t.options.nothingNow} />}</div>
      <div className="opt-grid">
        <div className="opt-field">
          <label className="opt-title" htmlFor={labelId}>
            {t.options.label}
          </label>
          <span className="flex items-center gap-1.5">
            <TextField
              id={labelId}
              className="field field-sm mono"
              disabled={label === null}
              value={label ?? ""}
              placeholder={label === null ? t.options.hidden : ""}
              onChange={(v) => setLabel(v === defaultLabel ? undefined : v)}
            />
            <button className="btn btn-sm" onClick={() => setLabel(label === null ? defaultLabel || name : null)}>
              {label === null ? t.options.show : t.options.hide}
            </button>
          </span>
        </div>
        <div className="opt-field">
          <label className="opt-title" htmlFor={emptyId}>
            {t.options.whenEmpty}
          </label>
          <span className="flex items-center gap-1.5">
            {/* Blank = follow Style → Empty widgets, which the placeholder text spells out. */}
            <TextField
              id={emptyId}
              className="field field-sm mono"
              disabled={ownEmpty === null}
              value={ownEmpty ?? ""}
              placeholder={ownEmpty === null ? t.options.hidden : globalEmpty !== "" && label === null ? t.options.whenEmptyNoLabel : t.options.whenEmptyInherit(globalEmpty)}
              onChange={(v) => setEmpty(v === "" ? undefined : v)}
            />
            <button className="btn btn-sm" onClick={() => setEmpty(ownEmpty === null ? undefined : null)}>
              {ownEmpty === null ? t.options.show : t.options.hide}
            </button>
          </span>
        </div>
        {enums.map((n) => (
          <EnumField key={n} ctx={ctx} name={n} />
        ))}
        {values.map((n) => (
          <ValueField key={n} ctx={ctx} name={n} />
        ))}
        <ColorField style={style} setStyle={setStyle} />
        {isThreshold && <ThresholdField ctx={ctx} />}
        {/* Bold sits with the widget's own switches: one toggle among the others, not behind a "More" fold. */}
        <TogglesField ctx={ctx} names={toggles} bold={!!style.bold} setBold={(b) => setStyle({ bold: b })} />
      </div>
    </div>
  );
}
