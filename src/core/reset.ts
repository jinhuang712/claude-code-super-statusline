/**
 * Counter baselines. Claude Code's cost / token / line totals only ever grow within a session;
 * `reset` (the CLI, or the panel's ⋯ → Reset counters) records their current values and the widgets show what accumulated since.
 * One JSON file per session id under the data root, 0600 like the samples.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getHudPluginDir } from "../data/claude-config-dir.js";
import type { SessionTokenUsage, StdinData } from "../data/types.js";

export interface ResetBaseline {
  at: number;
  costUsd: number;
  apiMs: number;
  linesAdded: number;
  linesRemoved: number;
  tokens: SessionTokenUsage;
  /**
   * Subagent totals at reset time (see subagents.ts). Absent in baselines written before subagents
   * were counted; those read as zero, so a pre-upgrade reset shows every subagent token since the
   * session started. That is the honest reading of an unknown baseline, not an undercount.
   */
  subagentTokens?: SessionTokenUsage;
}

export function resetsDir(homeDir = os.homedir()): string {
  return path.join(getHudPluginDir(homeDir), "resets");
}

function fileFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
  return path.join(resetsDir(), `${safe}.json`);
}

export function readBaseline(sessionId: string | undefined): ResetBaseline | null {
  if (!sessionId) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sessionId), "utf8")) as Partial<ResetBaseline>;
    if (typeof raw.at !== "number") return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const tok = (t: Partial<SessionTokenUsage> = {}): SessionTokenUsage => ({ inputTokens: n(t.inputTokens), outputTokens: n(t.outputTokens), cacheCreationTokens: n(t.cacheCreationTokens), cacheReadTokens: n(t.cacheReadTokens), apiCalls: n(t.apiCalls) });
    return {
      at: raw.at,
      costUsd: n(raw.costUsd),
      apiMs: n(raw.apiMs),
      linesAdded: n(raw.linesAdded),
      linesRemoved: n(raw.linesRemoved),
      tokens: tok(raw.tokens),
      subagentTokens: tok(raw.subagentTokens),
    };
  } catch {
    return null;
  }
}

export function writeBaseline(sessionId: string, b: ResetBaseline): string {
  const target = fileFor(sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

export function clearBaseline(sessionId: string): void {
  try {
    fs.unlinkSync(fileFor(sessionId));
  } catch {
    /* nothing to clear */
  }
}

/** Build a baseline from a stdin payload plus the parsed transcript totals. */
export function baselineFrom(stdin: StdinData, tokens: SessionTokenUsage | undefined, now = Date.now(), subagentTokens?: SessionTokenUsage | null): ResetBaseline {
  const none = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, apiCalls: 0 };
  return {
    at: now,
    costUsd: stdin.cost?.total_cost_usd ?? 0,
    apiMs: stdin.cost?.total_api_duration_ms ?? 0,
    linesAdded: stdin.cost?.total_lines_added ?? 0,
    linesRemoved: stdin.cost?.total_lines_removed ?? 0,
    tokens: tokens ?? none,
    subagentTokens: subagentTokens ?? none,
  };
}

/**
 * Totals since the baseline; never negative (a baseline from a previous session shape is just ignored).
 * `which` picks the baseline field to subtract: the main chain's (`tokens`) or the subagents'.
 */
export function netTokens(tokens: SessionTokenUsage | undefined | null, base: ResetBaseline | null, which: "tokens" | "subagentTokens" = "tokens"): SessionTokenUsage | undefined {
  if (!tokens) return undefined;
  const b = base?.[which];
  if (!b) return tokens;
  const d = (a: number | undefined, x: number | undefined) => Math.max(0, (a ?? 0) - (x ?? 0));
  return {
    inputTokens: d(tokens.inputTokens, b.inputTokens),
    outputTokens: d(tokens.outputTokens, b.outputTokens),
    cacheCreationTokens: d(tokens.cacheCreationTokens, b.cacheCreationTokens),
    cacheReadTokens: d(tokens.cacheReadTokens, b.cacheReadTokens),
    apiCalls: d(tokens.apiCalls, b.apiCalls),
  };
}
