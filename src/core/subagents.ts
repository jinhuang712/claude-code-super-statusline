/**
 * Token usage of a session's subagents, read from their own transcript files.
 *
 * Claude Code no longer interleaves subagent (Task / Agent tool) records into the session transcript.
 * Each subagent writes its own file next to it:
 *
 *   <project>/<session-id>.jsonl                                  the main chain (stdin.transcript_path)
 *   <project>/<session-id>/subagents/agent-<id>.jsonl             one per subagent
 *   <project>/<session-id>/subagents/workflows/wf_<id>/…/*.jsonl  agents started by a workflow
 *
 * so a parser that only reads `transcript_path` never sees their usage: on a session with a few
 * Explore agents that is easily a third of the tokens spent. (Checked on 162 local sessions that
 * have a `subagents/` folder: none of them also carries `isSidechain` records in the main file, so
 * adding these files to the main totals does not count anything twice.)
 *
 * Sessions can have hundreds of these files (one seen here: 179 files, 50 MB), so they are read
 * incrementally: a small per-session cache remembers, per file, how far it was read and what it
 * summed to. A finished subagent's file never changes again and costs one `stat` per render; a
 * running one is read from where the last render stopped.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getHudPluginDir } from "../data/claude-config-dir.js";
import type { SessionTokenUsage } from "../data/types.js";

/** Bump when the cache shape or the counting rules change, so old caches are re-read from scratch. */
const CACHE_VERSION = 1;
/**
 * `subagents/agent-*.jsonl` is depth 1; workflow agents sit at `workflows/wf_<id>/…`, a few levels
 * down. The cap only guards against a pathological tree (or a symlink loop) — nothing real is deeper.
 */
const MAX_DEPTH = 5;
/**
 * Claude Code writes one API response as several records that share `message.id` (one per content
 * block), always next to each other. Remembering the last few ids per file is enough to count each
 * response once, including across an incremental read that stops between two of those records.
 */
const RECENT_IDS_MAX = 32;
/** Same bound as the main transcript parser (MESSAGE_ID_MAX_LEN) so a malformed id can't bloat the cache. */
const MESSAGE_ID_MAX_LEN = 256;

/** One subagent transcript file found on disk. */
export interface SubagentFile {
  file: string;
  size: number;
  mtimeMs: number;
}

interface FileState {
  size: number;
  /** Bytes consumed so far: always the end of a complete line, never mid-record. */
  offset: number;
  tokens: SessionTokenUsage;
  /** message.id → the largest usage seen for it, newest last (see RECENT_IDS_MAX). */
  recent: Array<[string, SessionTokenUsage]>;
}

interface CacheFile {
  version: number;
  dir: string;
  files: Record<string, FileState>;
}

const zero = (): SessionTokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, apiCalls: 0 });

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** The folder holding a session's subagent transcripts, or null when there is no transcript path. */
export function subagentsDir(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  const dir = path.dirname(transcriptPath);
  const session = path.basename(transcriptPath, ".jsonl");
  return path.join(dir, session, "subagents");
}

/** Every `*.jsonl` under the subagents folder, with size and mtime. Missing folder → []. */
export function listSubagentFiles(transcriptPath: string | undefined): SubagentFile[] {
  const root = subagentsDir(transcriptPath);
  if (!root) return [];
  const out: SubagentFile[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no subagents yet (the usual case) or unreadable: nothing to add
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // Dirent types, not stat: symlinks are neither and are skipped, which also rules out loops.
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = fs.statSync(p);
          out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Deleted between readdir and stat: it has nothing to count any more.
        }
      }
    }
  };
  walk(root, 1);
  return out;
}

function cachePath(dir: string): string {
  const hash = createHash("sha256").update(path.resolve(dir)).digest("hex");
  return path.join(getHudPluginDir(os.homedir()), "subagent-cache", `${hash}.json`);
}

function readCache(dir: string): Record<string, FileState> {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(dir), "utf8")) as Partial<CacheFile>;
    if (raw.version !== CACHE_VERSION || raw.dir !== path.resolve(dir) || !raw.files || typeof raw.files !== "object") return {};
    return raw.files;
  } catch {
    return {}; // no cache yet, or a corrupt one: re-reading the files is always correct, just slower
  }
}

function writeCache(dir: string, files: Record<string, FileState>): void {
  const target = cachePath(dir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // Several statusline processes can render at once; write-then-rename keeps readers off half a file.
    const tmp = `${target}.${process.pid}.tmp`;
    const payload: CacheFile = { version: CACHE_VERSION, dir: path.resolve(dir), files };
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // A cache we can't write only means the next render reads the files again.
  }
}

/** Read `[from, size)` of a file. Returns "" when it can't be read. */
function readRange(file: string, from: number, size: number): string {
  if (size <= from) return "";
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Add the usage records in `text` to `state`. Only complete lines are consumed: a record still being
 * written (no trailing newline yet) is left for the next read, so the offset never lands mid-line.
 */
function consume(state: FileState, text: string): void {
  const end = text.lastIndexOf("\n");
  if (end < 0) return;
  const recent = new Map(state.recent);
  for (const line of text.slice(0, end).split("\n")) {
    // Cheap pre-filter: most records are tool results and prompts, and JSON.parse is the cost here.
    if (!line.includes('"usage"')) continue;
    let e: { type?: string; message?: { id?: unknown; usage?: Record<string, unknown> } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e.type === "assistant" ? e.message?.usage : undefined;
    if (!u) continue;
    const cur: SessionTokenUsage = {
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheCreationTokens: count(u.cache_creation_input_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens),
    };
    const id = typeof e.message?.id === "string" && e.message.id.length <= MESSAGE_ID_MAX_LEN ? e.message.id : null;
    const prev = id ? recent.get(id) : undefined;
    if (!prev) state.tokens.apiCalls = (state.tokens.apiCalls ?? 0) + 1;
    // Duplicate records of one response carry the same (final) usage; add only what grew, like the
    // main parser's accumulateMessageUsage, so a later, larger copy is never lost either.
    const p = prev ?? zero();
    state.tokens.inputTokens += Math.max(0, cur.inputTokens - p.inputTokens);
    state.tokens.outputTokens += Math.max(0, cur.outputTokens - p.outputTokens);
    state.tokens.cacheCreationTokens += Math.max(0, cur.cacheCreationTokens - p.cacheCreationTokens);
    state.tokens.cacheReadTokens += Math.max(0, cur.cacheReadTokens - p.cacheReadTokens);
    if (id) {
      recent.delete(id); // re-insert so the Map order stays "newest last"
      recent.set(id, {
        inputTokens: Math.max(p.inputTokens, cur.inputTokens),
        outputTokens: Math.max(p.outputTokens, cur.outputTokens),
        cacheCreationTokens: Math.max(p.cacheCreationTokens, cur.cacheCreationTokens),
        cacheReadTokens: Math.max(p.cacheReadTokens, cur.cacheReadTokens),
      });
      if (recent.size > RECENT_IDS_MAX) recent.delete(recent.keys().next().value!);
    }
  }
  state.offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
  state.recent = [...recent];
}

/**
 * Cumulative token usage of every subagent of the session whose transcript is `transcriptPath`,
 * or null when the session has no subagent files. Never throws.
 */
export function subagentTokens(transcriptPath: string | undefined): SessionTokenUsage | null {
  const dir = subagentsDir(transcriptPath);
  const files = listSubagentFiles(transcriptPath);
  if (!dir || files.length === 0) return null;
  const cached = readCache(dir);
  const next: Record<string, FileState> = {};
  let dirty = false;
  const total = zero();
  for (const f of files) {
    // Keyed by path relative to the folder: stable, and shorter than the absolute path.
    const key = path.relative(dir, f.file);
    let state = cached[key];
    // A file that shrank was replaced, not appended to: start over rather than trust the offset.
    if (!state || f.size < state.offset) state = { size: 0, offset: 0, tokens: zero(), recent: [] };
    if (f.size !== state.size) {
      consume(state, readRange(f.file, state.offset, f.size));
      state.size = f.size;
      dirty = true;
    }
    next[key] = state;
    total.inputTokens += state.tokens.inputTokens;
    total.outputTokens += state.tokens.outputTokens;
    total.cacheCreationTokens += state.tokens.cacheCreationTokens;
    total.cacheReadTokens += state.tokens.cacheReadTokens;
    total.apiCalls = (total.apiCalls ?? 0) + (state.tokens.apiCalls ?? 0);
  }
  // Files that disappeared drop out of `next`, so the cache never outgrows the folder.
  if (dirty || Object.keys(cached).length !== files.length) writeCache(dir, next);
  return total;
}
