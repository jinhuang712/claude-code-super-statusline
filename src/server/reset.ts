import { listLiveSamples } from "../core/capture.js";
import { loadEffectiveConfig } from "../core/config.js";
import { buildContext } from "../core/context.js";
import { baselineFrom, clearBaseline, writeBaseline, type ResetBaseline } from "../core/reset.js";
import type { StdinData } from "../data/types.js";
import { registerBuiltinWidgets } from "../widgets/index.js";

export interface ResetResult {
  sessionId: string;
  baseline: ResetBaseline;
  path: string;
}

/** Reset the counters of the most recently seen session (the one whose stdin was captured last). */
export async function resetLatestSession(sessionId?: string): Promise<ResetResult | null> {
  registerBuiltinWidgets();
  const samples = listLiveSamples();
  const sample = sessionId ? samples.find((s) => s.id === sessionId) : samples[0];
  if (!sample) return null;
  const stdin = sample.payload as StdinData;
  const id = stdin.session_id ?? sample.id;
  const { config } = loadEffectiveConfig(stdin.workspace?.current_dir ?? stdin.cwd);
  // Read the transcript with no baseline applied so the snapshot is the raw cumulative total.
  clearBaseline(id);
  const ctx = await buildContext(stdin, config, { columns: 120, deadlineMs: 3000 });
  const baseline = baselineFrom(stdin, ctx.transcript.sessionTokens, Date.now(), ctx.subagentTokens);
  const path = writeBaseline(id, baseline);
  return { sessionId: id, baseline, path };
}

export function undoReset(sessionId: string): void {
  clearBaseline(sessionId);
}
