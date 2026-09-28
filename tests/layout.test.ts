import { describe, expect, test } from "bun:test";
import { stripAnsi, truncateVisual, visualWidth } from "../src/core/ansi.ts";
import { guardLeadingSpace, layoutLine, render } from "../src/core/layout.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { registerWidget, _resetRegistry } from "../src/core/registry.ts";
import { defineWidget, type Ctx } from "../src/core/types.ts";

const z = (text: string) => ({ text, width: visualWidth(text) });

describe("visualWidth", () => {
  test("ascii, cjk, emoji, ansi", () => {
    expect(visualWidth("abc")).toBe(3);
    expect(visualWidth("中文")).toBe(4);
    expect(visualWidth("\x1b[32mok\x1b[0m")).toBe(2);
    expect(visualWidth("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe(4);
    expect(stripAnsi("\x1b[1;31mX\x1b[0m")).toBe("X");
  });
  test("emoji follow Ink/string-width widths (what Claude Code lays the row out with)", () => {
    expect(visualWidth("⚡")).toBe(2); // fast-mode marker in model.badge
    expect(visualWidth("⚠️")).toBe(2); // VS16 emoji presentation
    expect(visualWidth("⚠")).toBe(1); // text presentation stays narrow
    expect(visualWidth("🟢")).toBe(2);
    expect(visualWidth("👨‍👩‍👧")).toBe(2); // one ZWJ grapheme, not 6
    expect(visualWidth("é")).toBe(1); // combining acute
    expect(visualWidth("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe(4); // OSC 8 with ST terminator
  });
  test("truncate keeps cells within budget", () => {
    expect(truncateVisual("abcdefgh", 5)).toBe("abcd…");
    expect(visualWidth(truncateVisual("中文字符串", 5))).toBeLessThanOrEqual(5);
  });
});

describe("truncateVisual on styled text", () => {
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  const link = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

  test("escape bytes cost no width: a red 24-char string cut to 20 keeps 19 chars + ellipsis", () => {
    // Regression: the old cut counted `ESC[31m` as 4 visible cells and returned `hello…` (6 cells).
    const out = truncateVisual(`${RED}${"x".repeat(24)}${RESET}`, 20);
    expect(visualWidth(out)).toBe(20);
    expect(stripAnsi(out)).toBe(`${"x".repeat(19)}…`);
  });

  test("a cut inside a colour closes the colour after the ellipsis", () => {
    const out = truncateVisual(`${RED}${"x".repeat(24)}${RESET} tail`, 10);
    expect(out.startsWith(RED)).toBe(true);
    expect(out.endsWith(`…${RESET}`)).toBe(true);
  });

  test("a cut after the colour was reset adds no extra reset", () => {
    const out = truncateVisual(`${RED}ab${RESET}${"y".repeat(20)}`, 8);
    expect(out).toBe(`${RED}ab${RESET}yyyyy…`);
  });

  test("a cut inside an OSC 8 link terminates the link", () => {
    const out = truncateVisual(`see ${link("https://example.com", "a-very-long-link-text")} after`, 12);
    expect(visualWidth(out)).toBe(12);
    expect(out.endsWith("…\x1b]8;;\x07")).toBe(true);
    // Exactly one opener and one closer, so the terminal ends the hyperlink.
    expect(out.split("\x1b]8;;").length - 1).toBe(2);
  });

  test("a finished link before the cut is left alone", () => {
    const out = truncateVisual(`${link("https://x", "ok")} ${"z".repeat(30)}`, 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.split("\x1b]8;;").length - 1).toBe(2);
  });

  test("never splits a ZWJ emoji or a combining mark", () => {
    expect(truncateVisual("ab👨‍👩‍👧cdef", 4)).toBe("ab…"); // the family (2 cells) would overflow; it is dropped whole
    expect(truncateVisual("éééé", 3)).toBe("éé…");
  });

  test("zero budget yields an empty string", () => {
    expect(truncateVisual("abc", 0)).toBe("");
  });
});

describe("layoutLine truncate policy keeps styles intact", () => {
  test("the left zone is cut with its colour closed, and the right zone keeps its place", () => {
    const left = `\x1b[32m${"L".repeat(30)}\x1b[0m`;
    const right = `\x1b[33m${"R".repeat(30)}\x1b[0m`;
    const [row] = layoutLine({ left: z(left), center: z(""), right: z(right) }, 40, "truncate");
    expect(visualWidth(row!)).toBe(40);
    expect(row!).toContain("…\x1b[0m");
    expect(row!.endsWith(right)).toBe(true);
  });
});

/** A zone of several widgets, as renderZone builds it: the joined text plus the pieces "wrap" breaks at. */
function zoneOf(pieces: string[], sep = " | ") {
  const parts = pieces.map(z);
  return { text: pieces.join(sep), width: visualWidth(pieces.join(sep)), parts, sep: z(sep) };
}

describe("layoutLine", () => {
  test("right zone is anchored to the last column", () => {
    const [row] = layoutLine({ left: z("L"), center: z(""), right: z("RR") }, 20);
    expect(visualWidth(row!)).toBe(20);
    expect(row!.endsWith("RR")).toBe(true);
    expect(row!.startsWith("L")).toBe(true);
  });
  test("center floats between left and right", () => {
    const [row] = layoutLine({ left: z("LL"), center: z("CC"), right: z("RR") }, 20);
    expect(visualWidth(row!)).toBe(20);
    expect(row!.indexOf("CC")).toBe(9);
  });
  // The right zone never moves: it used to drop to a row of its own under a long left side.
  test("wrap keeps the right zone at the end of the first row and continues the left below", () => {
    const rows = layoutLine({ left: zoneOf(["a".repeat(8), "b".repeat(8), "c".repeat(8)]), center: z(""), right: z("R".repeat(10)) }, 30, "wrap");
    expect(rows).toEqual([`${"a".repeat(8)} | ${"b".repeat(8)}${" ".repeat(1)}${"R".repeat(10)}`, "c".repeat(8)]);
    expect(visualWidth(rows[0]!)).toBe(30);
  });
  test("wrap breaks between widgets, never inside one", () => {
    const rows = layoutLine({ left: zoneOf(["one", "two", "three", "four"]), center: z(""), right: z("RIGHT") }, 16, "wrap");
    expect(rows[0]!.endsWith("RIGHT")).toBe(true);
    for (const r of rows.slice(1)) expect(["one", "two", "three", "four"].some((w) => r.startsWith(w))).toBe(true);
    expect(rows.join("\n")).not.toContain("|\n");
  });
  test("wrap moves a left widget too wide for the first row to the next one", () => {
    const rows = layoutLine({ left: z("x".repeat(15)), center: z(""), right: z("y".repeat(10)) }, 20, "wrap");
    expect(rows).toEqual([`${" ".repeat(10)}${"y".repeat(10)}`, "x".repeat(15)]);
  });
  test("wrap cuts a single widget wider than the whole terminal", () => {
    const rows = layoutLine({ left: z("x".repeat(40)), center: z(""), right: z("y".repeat(5)) }, 20, "wrap");
    expect(rows[0]!.endsWith("y".repeat(5))).toBe(true);
    expect(visualWidth(rows[1]!)).toBe(20);
    expect(rows[1]!.endsWith("…")).toBe(true);
  });
  // wrap left holes in the right column on every continuation row, so truncate is the default.
  test("with no policy, an overflowing line stays one row and keeps the right zone", () => {
    const rows = layoutLine({ left: zoneOf(["p".repeat(12), "q".repeat(12)]), center: z(""), right: z("RR") }, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endsWith("RR")).toBe(true);
    expect(rows[0]!).toContain("…");
  });
  test("under every policy but drop-right, the first row ends with the right zone", () => {
    for (const policy of ["wrap", "truncate"] as const) {
      const [first] = layoutLine({ left: zoneOf(["p".repeat(12), "q".repeat(12)]), center: z(""), right: z("RR") }, 20, policy);
      expect(first!.endsWith("RR")).toBe(true);
      expect(visualWidth(first!)).toBe(20);
    }
  });
  // A line that uses one zone only (the Full preset's agents + todos line) used to come back whole
  // however wide it was, and the terminal broke it mid-word onto a second row.
  test("a line with only one zone is cut to the terminal like any other", () => {
    const left = layoutLine({ left: zoneOf(["p".repeat(12), "q".repeat(12)]), center: z(""), right: z("") }, 20);
    expect(left).toHaveLength(1);
    expect(visualWidth(left[0]!)).toBe(20);
    expect(left[0]!.endsWith("…")).toBe(true);
    for (const zone of ["center", "right"] as const) {
      const rows = layoutLine({ left: z(""), center: z(""), right: z(""), [zone]: z("x".repeat(30)) }, 20);
      expect(rows).toEqual([`${"x".repeat(19)}…`]);
    }
  });
  test("wrap on a one-zone line breaks between widgets and fills whole rows", () => {
    const rows = layoutLine({ left: zoneOf(["a".repeat(8), "b".repeat(8), "c".repeat(8)]), center: z(""), right: z("") }, 20, "wrap");
    expect(rows).toEqual([`${"a".repeat(8)} | ${"b".repeat(8)}`, "c".repeat(8)]);
  });
  test("drop-right never blanks a line whose only zone is the right one", () => {
    expect(layoutLine({ left: z(""), center: z(""), right: z("y".repeat(30)) }, 20, "drop-right")).toEqual([`${"y".repeat(19)}…`]);
  });
  test("drop-right policy hides the right zone", () => {
    const rows = layoutLine({ left: z("x".repeat(15)), center: z(""), right: z("y".repeat(10)) }, 20, "drop-right");
    expect(rows).toEqual(["x".repeat(15)]);
  });
  test("unknown width falls back to plain join", () => {
    expect(layoutLine({ left: z("a"), center: z(""), right: z("b") }, 0)).toEqual(["a b"]);
  });
});

describe("render", () => {
  test("unknown and throwing widgets never blank the line", () => {
    _resetRegistry();
    registerWidget(defineWidget({ id: "boom", name: "boom", description: "", category: "misc", schema: {}, defaults: {}, render: () => { throw new Error("nope"); } }));
    registerWidget(defineWidget({ id: "ok", name: "ok", description: "", category: "misc", schema: {}, defaults: {}, render: () => "fine" }));
    const ctx = { columns: 40, now: 0 } as unknown as Omit<Ctx, "theme" | "colorMode">;
    const out = render({ ...DEFAULT_CONFIG, colorLevel: "none", lines: [{ left: [{ widget: "ok" }, { widget: "boom" }, { widget: "missing" }] }] }, ctx);
    expect(out.lines[0]).toBe("fine │ ⚠ boom │ ⚠ missing");
    expect(out.errors.map((e) => e.widget)).toEqual(["boom", "missing"]);
  });
});

describe("guardLeadingSpace survives Claude Code's per-line trim", () => {
  // What Claude Code 2.1.283 does to the command's stdout before drawing it (anthropics/claude-code#29206).
  const claudeCodeClean = (stdout: string) =>
    stdout
      .trim()
      .split("\n")
      .flatMap((l) => l.trim() || [])
      .join("\n");

  test("a right-only row stays right-aligned", () => {
    const [row] = layoutLine({ left: z(""), center: z(""), right: z("[Opus 5.5]") }, 30);
    expect(claudeCodeClean(row)).toBe("[Opus 5.5]"); // the bug: the padding is gone
    const guarded = guardLeadingSpace(row);
    expect(stripAnsi(claudeCodeClean(guarded))).toBe(" ".repeat(20) + "[Opus 5.5]");
    expect(visualWidth(guarded)).toBe(30); // the guard adds no width
  });

  test("rows that start with content are left as they are", () => {
    expect(guardLeadingSpace("Project ~/x   right")).toBe("Project ~/x   right");
    const out = ["      right", "left     right2"].map(guardLeadingSpace).join("\n") + "\n";
    expect(stripAnsi(claudeCodeClean(out)).split("\n")).toEqual(["      right", "left     right2"]);
  });
});
