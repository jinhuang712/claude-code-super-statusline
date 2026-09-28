/**
 * Output speed of the latest model response, measured from the transcript (and, through
 * latestResponseSpeed, from the session's subagent transcripts).
 *
 * Why not the stdin-based tracker claude-hud uses: it needs two statusline renders 0.5–2 s apart
 * while `current_usage.output_tokens` grows. Claude Code re-runs the statusline when a *new message
 * arrives* (debounced 300 ms), not while a response streams, and `current_usage` is per response —
 * so that tracker could never produce a reading here, and the widget never showed.
 *
 * The transcript has what is needed instead. Each API response is written as one or more assistant
 * entries sharing `message.id`, all carrying the response's final `usage`, and they only appear
 * once the response is complete — so a half-streamed response is never measured. The request
 * started at the preceding `user` entry (the prompt or the tool_result that triggered the call).
 *
 *   speed = output_tokens / (last entry of the response − that user entry)
 *
 * That is end-to-end throughput, time-to-first-token included. Very short responses are dominated
 * by that latency and would read as "slow", so responses below `minTokens` are skipped and the most
 * recent long-enough one is reported.
 *
 * Cost: only the file's tail is read (TAIL_BYTES), so this stays well under a millisecond even on
 * 100 MB transcripts.
 */
import * as fs from "node:fs";
import { listSubagentFiles } from "./subagents.js";

/** Enough for the last several responses including large tool results; one read, no scan of the file. */
const TAIL_BYTES = 256 * 1024;
/** Below this, time-to-first-token dominates and the figure says more about latency than speed. */
export const MIN_RESPONSE_TOKENS = 200;

export interface ResponseSpeed {
  /** Output tokens per second, end to end. */
  tokensPerSecond: number;
  outputTokens: number;
  durationMs: number;
  /** When the measured response finished (epoch ms). */
  finishedAt: number;
}

interface Entry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { id?: string; usage?: { output_tokens?: number } };
}

/** Read the last `bytes` of a file and return its complete lines (the first, partial one is dropped). */
function tailLines(file: string, bytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift(); // started mid-line
    return lines.filter(Boolean);
  } catch {
    return []; // missing or unreadable transcript: no measurement, never an error
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The latest response of at least `minTokens` output tokens, or null when none is in the tail.
 * `sidechain: true` reads a subagent's own transcript, where every record is marked isSidechain.
 */
export function lastResponseSpeed(transcriptPath: string | undefined, minTokens = MIN_RESPONSE_TOKENS, sidechain = false): ResponseSpeed | null {
  if (!transcriptPath) return null;
  let lastUserAt = 0;
  // Responses in the order they appear; each remembers when its request started.
  const responses = new Map<string, { start: number; end: number; out: number }>();
  for (const line of tailLines(transcriptPath, TAIL_BYTES)) {
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    // Subagent chatter interleaves with the main chain in older transcripts: timing across two chains
    // would pair one chain's request with the other's response, so only the file's own chain counts.
    if (Boolean(e.isSidechain) !== sidechain || !e.timestamp) continue;
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    if (e.type === "user") {
      lastUserAt = at;
    } else if (e.type === "assistant" && e.message?.id) {
      const out = e.message.usage?.output_tokens;
      const r = responses.get(e.message.id);
      if (r) {
        r.end = at;
        if (typeof out === "number") r.out = Math.max(r.out, out);
      } else if (lastUserAt > 0) {
        // Without a preceding user entry in the tail we can't know when the request started.
        responses.set(e.message.id, { start: lastUserAt, end: at, out: typeof out === "number" ? out : 0 });
      }
    }
  }
  // Newest first: the Map keeps insertion (= transcript) order.
  const list = [...responses.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    const ms = r.end - r.start;
    if (r.out >= minTokens && ms > 0) return { tokensPerSecond: r.out / (ms / 1000), outputTokens: r.out, durationMs: ms, finishedAt: r.end };
  }
  return null;
}

/**
 * The latest long-enough response of the session, main chain or any subagent (see subagents.ts for
 * where their transcripts live). Each file is timed on its own, so parallel agents never pair one
 * agent's request with another's response.
 *
 * Subagent files are visited newest first and the walk stops at the first one last written before
 * the best response found so far: a response can't finish after its file was last written, so no
 * older file can win. That usually means one or two tail reads, even with hundreds of files.
 */
export function latestResponseSpeed(transcriptPath: string | undefined, minTokens = MIN_RESPONSE_TOKENS): ResponseSpeed | null {
  let best = lastResponseSpeed(transcriptPath, minTokens);
  const files = listSubagentFiles(transcriptPath).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    if (best && f.mtimeMs < best.finishedAt) break;
    const r = lastResponseSpeed(f.file, minTokens, true);
    if (r && (!best || r.finishedAt > best.finishedAt)) best = r;
  }
  return best;
}
