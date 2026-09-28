/**
 * Builds the widget-facing context from stdin + the harvested data collectors.
 * Collectors run concurrently and each is individually bounded so a slow git never blanks the line.
 */
import { readBaseline } from "./reset.js";
import { applyContextWindowFallback } from "../data/context-cache.js";
import { countConfigs } from "../data/config-reader.js";
import { resolveEffortLevel } from "../data/effort.js";
import { getUsageFromStdin } from "../data/stdin.js";
import { parseTranscript } from "../data/transcript.js";
import { latestResponseSpeed } from "./response-speed.js";
import { subagentTokens } from "./subagents.js";
import { countPluginMcpServers } from "./plugin-mcp.js";
import { originRepo } from "./git-remote.js";
import { getClaudeConfigDir } from "../data/claude-config-dir.js";
import * as os from "node:os";
import type { StdinData, TranscriptData } from "../data/types.js";
import { formatDuration } from "./api.js";
import type { Ctx, FooterConfig } from "./types.js";
import { resolveVcsStatus, VCS_DEADLINE_MS } from "./vcs-cache.js";

// Kept importable from here for existing callers; the implementation lives in vcs-cache.ts.
export { resolveVcsStatus } from "./vcs-cache.js";

export interface BuildOptions {
  columns?: number;
  now?: number;
  /** Deadline in ms for the local collectors (transcript, config counts). */
  deadlineMs?: number;
  /**
   * How long to wait for a fresh git/jj status before rendering the cached one instead (the cache
   * is then refreshed in the background). Kept short: git is the only collector that shells out and
   * can stall on big or network repos, while the whole render must beat Claude Code's ~300 ms debounce.
   */
  gitDeadlineMs?: number;
}

async function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- context ---------------------------------------------------------------

const EMPTY_TRANSCRIPT: TranscriptData = { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] };

export function resolveColumns(env: NodeJS.ProcessEnv = process.env, offset = 0): number {
  const raw = env.COLUMNS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  let cols = 0;
  if (Number.isFinite(n) && n > 10) cols = n;
  else if (process.stdout.columns && process.stdout.columns > 10) cols = process.stdout.columns;
  if (cols === 0) return 0; // unknown → layout falls back to plain joins
  return Math.max(20, cols - offset);
}

export async function buildContext(stdin: StdinData, config: FooterConfig, opts: BuildOptions = {}): Promise<Omit<Ctx, "theme" | "colorMode">> {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadlineMs ?? 1500;
  const cwd = stdin.workspace?.current_dir ?? stdin.cwd;

  const transcriptP = bounded(parseTranscript(stdin.transcript_path ?? ""), deadline, EMPTY_TRANSCRIPT);
  const countsP = bounded(countConfigs(cwd), deadline, { claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0 });
  // resolveVcsStatus enforces its own, much shorter deadline and falls back to the cached status.
  const gitP = resolveVcsStatus(cwd, config, now, { deadlineMs: opts.gitDeadlineMs ?? VCS_DEADLINE_MS }).catch(() => null);

  const transcript = await transcriptP;
  applyContextWindowFallback(stdin, {}, transcript.sessionName, {
    lastCompactBoundaryAt: transcript.lastCompactBoundaryAt,
    lastCompactPostTokens: transcript.lastCompactPostTokens,
  });
  const [counts, gitStatus] = await Promise.all([countsP, gitP]);

  const effort = resolveEffortLevel(stdin.effort, { ultracodeActive: transcript.ultracodeActive });
  const sessionDuration = transcript.sessionStart ? formatDuration(now - transcript.sessionStart.getTime()) : "";

  return {
    stdin,
    transcript,
    claudeMdCount: counts.claudeMdCount,
    rulesCount: counts.rulesCount,
    // Settings/.mcp.json servers (claude-hud's reader) plus the ones plugins bring (see plugin-mcp.ts).
    mcpCount: counts.mcpCount + countPluginMcpServers(getClaudeConfigDir(os.homedir()), cwd),
    hooksCount: counts.hooksCount,
    sessionDuration,
    gitStatus,
    usageData: getUsageFromStdin(stdin),
    memoryUsage: null,
    extraLabel: null,
    outputStyle: counts.outputStyle,
    effortLevel: effort?.level,
    effortSymbol: effort?.symbol,
    columns: opts.columns ?? resolveColumns(process.env, config.columnsOffset),
    now,
    reset: readBaseline(stdin.session_id),
    // Tail reads of the transcript and the newest subagent files; cheap enough to do on every render.
    responseSpeed: latestResponseSpeed(stdin.transcript_path),
    // Incremental and cached per file: ~1 ms warm even for a session with 179 subagent files.
    subagentTokens: subagentTokens(stdin.transcript_path),
    // Only read .git/config when stdin lacks the repo: Claude Code's value wins whenever it is sent.
    originRepo: (stdin as { workspace?: { repo?: unknown } }).workspace?.repo ? null : originRepo(cwd),
  };
}
