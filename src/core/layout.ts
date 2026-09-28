/**
 * The render engine: config + ctx → ANSI lines.
 * Each line has left / center / right zones; right is anchored to the terminal edge.
 */
import { detectColorLevel, renderSegments, truncateVisual, visualWidth } from "./ansi.js";
import { createApi } from "./api.js";
import { getWidget } from "./registry.js";
import { resolveTheme } from "./theme.js";
import { labelPrefix } from "../widgets/_shared.js";
import type { ColorLevel, Ctx, FooterConfig, LineConfig, RenderOptions, RenderResult, Segment, Style, WidgetInstance, Zone } from "./types.js";

interface RenderedWidget {
  text: string;
  width: number;
  /** A zone's widgets one by one, and the styled separator between them — what "wrap" breaks at. */
  parts?: RenderedWidget[];
  sep?: RenderedWidget;
}
/** Marks rendered widgets whose text is the sample stand-in, so the caller can report them. */
const filledOut = new WeakMap<RenderedWidget, true>();
/** Marks rendered widgets whose text is the configured emptyText placeholder. */
const placeheld = new WeakMap<RenderedWidget, true>();

/**
 * The muted "Label –" an empty widget prints, or null to hide it. The widget's own emptyText wins
 * and shows even without a label; the config-wide one only fills in labelled widgets, since a bare
 * "–" would not say what is missing (and would clutter unlabelled ones like the model badge).
 */
export function placeholderFor(inst: WidgetInstance, label: unknown, globalEmptyText: string): Segment[] | null {
  const own = inst.emptyText;
  const text = own !== undefined ? (own ?? "") : globalEmptyText;
  if (text === "") return null;
  const name = typeof label === "string" && label !== "" ? label : null;
  if (own === undefined && !name) return null;
  return [{ text: `${labelPrefix(name)}${text}`, style: { fg: "muted" } }];
}

function mergeStyle(base: Style | undefined, override: Style | undefined): Style | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

function applyOverride(segs: Segment[], override: Style | undefined): Segment[] {
  if (!override) return segs;
  return segs.map((s) => ({ ...s, style: mergeStyle(s.style, override) }));
}

function renderInstance(
  inst: WidgetInstance,
  ctx: Ctx,
  level: Exclude<ColorLevel, "auto">,
  errors: RenderResult["errors"],
  fillEmpty = false,
  globalEmptyText = "",
): RenderedWidget | null {
  const def = getWidget(inst.widget);
  const api = createApi(ctx.theme, ctx.now, ctx.colorMode);
  if (!def) {
    errors.push({ widget: inst.widget, message: "unknown widget" });
    const text = renderSegments([{ text: `⚠ ${inst.widget}`, style: { fg: "muted", dim: true } }], ctx.theme, level);
    return { text, width: visualWidth(text) };
  }
  try {
    const opts = { ...def.defaults, ...(inst.options ?? {}) };
    // The instance label is either the widget's own `label` option or, for widgets without one, a
    // generic muted prefix added below — never both (that printed "Env Env prod").
    const ownsLabel = Boolean(def.schema.properties && "label" in def.schema.properties);
    if (ownsLabel && inst.label !== undefined) (opts as Record<string, unknown>).label = inst.label;
    const out = def.render(ctx, opts, api);
    let segs: Segment[] = out === null || out === undefined ? [] : typeof out === "string" ? [{ text: out }] : out;
    let filled = false;
    if (segs.length === 0 || segs.every((s) => s.text === "")) {
      // A configured placeholder beats the preview's sample: it is what Claude Code will show, and
      // the preview is where the user checks that it reads right.
      const holder = placeholderFor(inst, ownsLabel ? opts.label : inst.label, globalEmptyText);
      if (holder) {
        const text = renderSegments(holder, ctx.theme, level);
        const rendered = { text, width: visualWidth(text) };
        placeheld.set(rendered, true);
        return rendered;
      }
      const sample = def.sampleFor?.(opts) || def.sample;
      if (!fillEmpty || !sample) return null;
      segs = [{ text: sample }];
      filled = true;
    }
    // Widgets that do not know about labels still get one: a muted prefix set from the instance.
    if (!ownsLabel && typeof inst.label === "string" && inst.label !== "") segs = [{ text: `${inst.label} `, style: { fg: "muted" } }, ...segs];
    const text = renderSegments(applyOverride(segs, inst.style), ctx.theme, level);
    const rendered = { text, width: visualWidth(text) };
    if (filled) filledOut.set(rendered, true);
    return rendered;
  } catch (err) {
    errors.push({ widget: inst.widget, message: err instanceof Error ? err.message : String(err) });
    const text = renderSegments([{ text: `⚠ ${inst.widget}`, style: { fg: "crit", dim: true } }], ctx.theme, level);
    return { text, width: visualWidth(text) };
  }
}

function renderZone(
  items: WidgetInstance[] | undefined,
  ctx: Ctx,
  level: Exclude<ColorLevel, "auto">,
  separator: string,
  errors: RenderResult["errors"],
  empty: RenderResult["empty"],
  at: { line: number; zone: Zone },
  fillEmpty: boolean,
  emptyText: string,
): RenderedWidget {
  const rendered: RenderedWidget[] = [];
  (items ?? []).forEach((inst, index) => {
    const r = renderInstance(inst, ctx, level, errors, fillEmpty, emptyText);
    if (r) {
      rendered.push(r);
      if (filledOut.has(r)) empty.push({ ...at, index, widget: inst.widget, filled: true });
      else if (placeheld.has(r)) empty.push({ ...at, index, widget: inst.widget, placeholder: true });
    } else empty.push({ ...at, index, widget: inst.widget });
  });
  if (rendered.length === 0) return { text: "", width: 0 };
  const sepStyled = renderSegments([{ text: separator, style: { fg: "muted" } }], ctx.theme, level);
  const text = rendered.map((r) => r.text).join(sepStyled);
  const width = rendered.reduce((w, r) => w + r.width, 0) + visualWidth(separator) * (rendered.length - 1);
  return { text, width, parts: rendered, sep: { text: sepStyled, width: visualWidth(separator) } };
}

function pad(n: number): string {
  return n > 0 ? " ".repeat(n) : "";
}

/**
 * Lay out one line's zones into 1+ physical rows. The default overflow is "truncate": one row per
 * line, always. "wrap" left the right column with holes on every continuation row, which read as
 * missing data; it stays available per line.
 */
export function layoutLine(zones: Record<Zone, RenderedWidget>, columns: number, overflow: LineConfig["overflow"] = "truncate"): string[] {
  const { left, center, right } = zones;
  const parts = [left, center, right].filter((z) => z.width > 0);
  if (parts.length === 0) return [];
  // One zone that fits: place it and done. One that doesn't goes through the overflow rules below
  // like any other line; it used to come back whole, and the terminal broke it mid-word.
  if (parts.length === 1 && (columns <= 0 || parts[0]!.width <= columns)) {
    const only = parts[0]!;
    if (only === right && columns > 0) return [pad(columns - right.width) + right.text];
    if (only === center && columns > 0) return [pad(Math.floor((columns - center.width) / 2)) + center.text];
    return [only.text];
  }
  const gaps = parts.length - 1; // at least one space between zones
  const needed = left.width + center.width + right.width + gaps;
  if (columns <= 0 || needed <= columns) {
    if (columns <= 0) return [parts.map((p) => p.text).join(" ")];
    let row = left.text;
    let cursor = left.width;
    if (center.width > 0) {
      const ideal = Math.floor((columns - center.width) / 2);
      const minStart = cursor + (cursor > 0 ? 1 : 0);
      const maxStart = columns - center.width - (right.width > 0 ? right.width + 1 : 0);
      const start = Math.max(minStart, Math.min(ideal, maxStart));
      row += pad(start - cursor) + center.text;
      cursor = start + center.width;
    }
    if (right.width > 0) {
      row += pad(columns - right.width - cursor) + right.text;
    }
    return [row];
  }
  // Overflow. The right zone never moves: it keeps the end of the first row, whatever the left side
  // does. (It used to drop to a row of its own under a long left side, which read as the two sides
  // pushing each other around.) What gives is the left, together with the center, which has no
  // room of its own to float in once the line is full.
  // With nothing but the right zone there is nothing to drop it for: it is cut like any other.
  if (overflow === "drop-right" && (left.width > 0 || center.width > 0)) {
    // Kept for configs that chose it; the panel no longer offers it (it hides the right zone).
    return layoutLine({ left, center, right: { text: "", width: 0 } }, columns, "truncate");
  }
  const rightText = right.width <= columns ? right.text : truncateVisual(right.text, columns);
  const rightWidth = Math.min(right.width, columns);
  // Room for the left side on the first row: everything but the right zone and one space before it.
  const room = right.width > 0 ? Math.max(0, columns - rightWidth - 1) : columns;
  const withRight = (text: string, width: number) => (right.width > 0 ? text + pad(columns - rightWidth - width) + rightText : text);

  if (overflow === "truncate") {
    const joined = [left, center].filter((z) => z.width > 0).map((z) => z.text).join(" ");
    const cut = truncateVisual(joined, room);
    return [withRight(cut, visualWidth(cut))];
  }

  // "wrap" (opt-in per line): fill the first row's room with whole widgets, then continue on full-width
  // rows below. Breaks fall between widgets, never inside one; a widget wider than a whole row is
  // cut to it. When not even the first widget fits beside the right zone, it starts the second row.
  const flow: Array<{ piece: RenderedWidget; joiner: RenderedWidget }> = [];
  const space = { text: " ", width: 1 };
  for (const zone of [left, center]) {
    if (zone.width === 0) continue;
    const pieces = zone.parts ?? [zone];
    pieces.forEach((piece, i) => flow.push({ piece, joiner: i === 0 ? space : (zone.sep ?? space) }));
  }
  const rows: Array<{ text: string; width: number }> = [{ text: "", width: 0 }];
  for (const { piece, joiner } of flow) {
    for (;;) {
      const row = rows[rows.length - 1]!;
      const budget = rows.length === 1 ? room : columns;
      const add = row.width > 0 ? joiner.width + piece.width : piece.width;
      if (row.width + add <= budget) {
        row.text += (row.width > 0 ? joiner.text : "") + piece.text;
        row.width += add;
        break;
      }
      if (row.width > 0 || rows.length === 1) {
        rows.push({ text: "", width: 0 });
        continue;
      }
      // An empty continuation row and still too wide: this one widget is wider than the terminal.
      const cut = truncateVisual(piece.text, columns);
      row.text = cut;
      row.width = visualWidth(cut);
      break;
    }
  }
  const [first, ...rest] = rows;
  return [withRight(first!.text, first!.width), ...rest.map((r) => r.text)];
}

/**
 * Keep a row's leading padding alive through Claude Code, which cleans the command's stdout with
 * `stdout.trim().split("\n").flatMap((l) => l.trim() || [])` (seen in 2.1.283; upstream issue
 * anthropics/claude-code#29206). A row that is only a right or center zone starts with spaces, and
 * that trim threw them away, so e.g. a right-aligned model badge showed at the left edge whenever
 * the left zone was empty (a fresh session without a name yet).
 * A leading SGR reset is zero-width and not whitespace to `String.prototype.trim`, so the spaces
 * after it survive. NBSP would not: `trim` strips it like any other Unicode space.
 */
export function guardLeadingSpace(line: string): string {
  return /^\s/.test(line) ? `\x1b[0m${line}` : line;
}

export function render(config: FooterConfig, ctx: Omit<Ctx, "theme" | "colorMode">, options: RenderOptions = {}): RenderResult {
  const fillEmpty = options.fillEmpty === true;
  const started = performance.now();
  const base = resolveTheme(config.theme);
  const theme = config.bar?.filled && config.bar.empty ? { ...base, bar: config.bar } : base;
  const level = config.colorLevel === "auto" ? detectColorLevel() : config.colorLevel;
  const fullCtx: Ctx = { ...ctx, theme, colorMode: config.colorMode };
  const errors: RenderResult["errors"] = [];
  const empty: RenderResult["empty"] = [];
  const lines: string[] = [];
  config.lines.forEach((line, li) => {
    if (line.minColumns && ctx.columns > 0 && ctx.columns < line.minColumns) return;
    const sep = line.separator ?? config.separator;
    // `?? ""`: callers may hand in a config that never went through normalizeConfig (tests, plugins).
    const emptyText = config.emptyText ?? "";
    const zones: Record<Zone, RenderedWidget> = {
      left: renderZone(line.left, fullCtx, level, sep, errors, empty, { line: li, zone: "left" }, fillEmpty, emptyText),
      center: renderZone(line.center, fullCtx, level, sep, errors, empty, { line: li, zone: "center" }, fillEmpty, emptyText),
      right: renderZone(line.right, fullCtx, level, sep, errors, empty, { line: li, zone: "right" }, fillEmpty, emptyText),
    };
    lines.push(...layoutLine(zones, ctx.columns, line.overflow));
  });
  return { lines, errors, empty, ms: performance.now() - started };
}
