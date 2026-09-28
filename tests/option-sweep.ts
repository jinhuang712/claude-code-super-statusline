/**
 * Shared machinery for the option sweep (tests/option-sweep.test.ts): render every built-in widget
 * with its defaults and with every value of every option — requirements (`x-requires`) satisfied —
 * against every built-in sample, the same way the statusline does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeConfig } from "../src/core/config.ts";
import { buildContext } from "../src/core/context.ts";
import { prepareFixture } from "../src/core/fixtures.ts";
import { render } from "../src/core/layout.ts";
import { widgetManifest } from "../src/core/registry.ts";
import type { FooterConfig, JsonSchema, WidgetInstance } from "../src/core/types.ts";
import { ensureBuiltins, runGit } from "./helpers.ts";

export const FIXTURES_DIR = path.resolve(import.meta.dir, "../src/fixtures");
/** The env var custom.env is pointed at, so its options have something to show. */
export const SWEEP_ENV = "SSP_SWEEP_VALUE";

/** Options every instance of a widget needs before anything shows (custom.env: which variable). */
export const BASE_OPTIONS: Record<string, Record<string, unknown>> = { "custom.env": { name: SWEEP_ENV } };

/** Hand-picked values where "TEST"/"" would never produce output. */
const VALUE_OVERRIDES: Record<string, unknown[]> = { "custom.env.name": [SWEEP_ENV, ""], "custom.env.color": ["#ff0000", "red"] };

export function valuesFor(widgetId: string, name: string, schema: JsonSchema, def: unknown): unknown[] {
  const override = VALUE_OVERRIDES[`${widgetId}.${name}`];
  if (override) return override;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const out: unknown[] = [];
  if (schema.enum) out.push(...schema.enum);
  else if (types.includes("boolean")) out.push(true, false);
  else if (types.includes("integer") || types.includes("number")) {
    const d = typeof def === "number" ? def : 5;
    out.push(schema.minimum ?? 0, 1, d, d * 2, schema.maximum ?? d * 4);
  } else out.push("TEST", "");
  if (types.includes("null")) out.push(null);
  return [...new Set(out.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as unknown);
}

const BASE = { version: 2 as const, theme: "default", colorLevel: "truecolor" as const, separator: " │ ", columnsOffset: 0, git: { enabled: false, cacheMs: 0 }, plugins: { dirs: [] as string[], trustedProjects: [] as string[] }, captureSamples: false };

export interface SweepContext {
  id: string;
  ctx: Awaited<ReturnType<typeof buildContext>>;
}

/**
 * A throwaway repository in a state every git.branch option can show: one commit ahead of its
 * upstream, a modified and an untracked file, and a GitHub-style origin (for the branch link).
 * The upstream ref is written directly, so nothing is ever fetched or pushed.
 */
function sweepRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ssp-sweep-repo-"));
  runGit(repo, "init", "-q");
  runGit(repo, "remote", "add", "origin", "https://github.com/acme/webapp.git");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-qm", "base");
  runGit(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  runGit(repo, "branch", "-q", "--set-upstream-to=origin/main");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-qm", "ahead by one");
  fs.writeFileSync(path.join(repo, "a.txt"), "a changed\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
  // Project config files, so environment.counts has something to count (it reads disk, not stdin).
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# rules of the house\n");
  fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "true" } } }));
  fs.mkdirSync(path.join(repo, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "rules", "style.md"), "Use tabs.\n");
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
  return repo;
}

/**
 * One context per built-in sample, plus the basic sample pointed at a real repository so git
 * options have data. Fixture paths are made up, so git is off for them.
 */
export async function sampleContexts(): Promise<SweepContext[]> {
  ensureBuiltins();
  process.env[SWEEP_ENV] = "prod";
  const out: SweepContext[] = await Promise.all(
    fs
      .readdirSync(FIXTURES_DIR)
      .filter((x) => x.endsWith(".json"))
      .map(async (f) => {
        const file = path.join(FIXTURES_DIR, f);
        const payload = prepareFixture(JSON.parse(fs.readFileSync(file, "utf8")), file);
        return { id: f.replace(/\.json$/, ""), ctx: await buildContext(payload, normalizeConfig({ ...BASE, lines: [] }), { columns: 200, now: Date.now() }) };
      }),
  );
  const basicFile = path.join(FIXTURES_DIR, "basic.json");
  const repo = sweepRepo();
  const inRepo = prepareFixture({ ...JSON.parse(fs.readFileSync(basicFile, "utf8")), cwd: repo }, basicFile);
  inRepo.workspace = { ...inRepo.workspace, current_dir: repo, project_dir: repo };
  const gitConfig = normalizeConfig({ ...BASE, git: { enabled: true, cacheMs: 0 }, lines: [] });
  // A generous git deadline: the sweep wants the real status, not the "too slow, use cache" path.
  out.push({ id: "basic-in-git-repo", ctx: await buildContext(inRepo, gitConfig, { columns: 200, now: Date.now(), gitDeadlineMs: 10_000 }) });
  // A direct session whose cost Claude Code didn't report, so cost.session has to estimate it.
  const noCost = prepareFixture(JSON.parse(fs.readFileSync(basicFile, "utf8")), basicFile);
  delete noCost.cost?.total_cost_usd;
  out.push({ id: "basic-without-cost", ctx: await buildContext(noCost, normalizeConfig({ ...BASE, lines: [] }), { columns: 200, now: Date.now() }) });
  return out;
}

/** Render one instance the way the statusline would; `config` sets top-level keys such as colorMode. */
export function renderOne(inst: WidgetInstance, ctx: SweepContext["ctx"], config: Partial<FooterConfig> = {}): { raw: string; errors: string[] } {
  const r = render(normalizeConfig({ ...BASE, ...config, lines: [{ left: [inst] }] }), ctx, { fillEmpty: false });
  return { raw: r.lines[0] ?? "", errors: r.errors.map((e) => e.message) };
}

// Strips SGR colour codes and OSC 8 hyperlinks: matching ESC/BEL control characters is the point.
// eslint-disable-next-line no-control-regex
export const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "");

export function builtinWidgets() {
  ensureBuiltins();
  return widgetManifest().filter((w) => w.source === "builtin");
}

/** Options a widget instance needs so that `name` can take effect (from x-requires). */
export function requirementsOf(schema: JsonSchema): Record<string, unknown> {
  const req = schema["x-requires"];
  return req && typeof req === "object" ? req : {};
}

/** Top-level config keys an option needs so that it can take effect (from x-requires-config). */
export function configRequirementsOf(schema: JsonSchema): Record<string, unknown> {
  const req = schema["x-requires-config"];
  return req && typeof req === "object" ? req : {};
}
