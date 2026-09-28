/**
 * Subagent usage lives in `<session>/subagents/**.jsonl`, not in the session transcript, so
 * tokens.session used to leave it out entirely (src/core/subagents.ts). These cases pin the rules:
 * every file under the folder counts (workflow agents included), one response counts once, an
 * incremental read ends where a full read would, and the reset baseline nets subagents separately.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { subagentTokens } from "../src/core/subagents";
import { netTokens, readBaseline, writeBaseline, baselineFrom } from "../src/core/reset";
import { renderWidget } from "./helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssp-subagents-"));
let n = 0;
const usage = (out: number, cr = 0) => ({ input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr });
const asst = (id: string, out: number, cr = 0) => ({ type: "assistant", isSidechain: true, timestamp: "2026-09-28T10:00:00.000Z", message: { id, role: "assistant", usage: usage(out, cr) } });
const user = { type: "user", isSidechain: true, timestamp: "2026-09-28T10:00:00.000Z", message: { role: "user", content: "go" } };
const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** A fresh session: main transcript plus the given subagent files (relative path → entries). */
function session(main: unknown[], subs: Record<string, unknown[]>): string {
  const dir = path.join(root, `p${n++}`);
  const transcript = path.join(dir, "sess.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(transcript, jsonl(main));
  for (const [rel, entries] of Object.entries(subs)) {
    const f = path.join(dir, "sess", "subagents", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, jsonl(entries));
  }
  return transcript;
}

describe("subagentTokens", () => {
  test("sums every subagent file, workflow agents included; .meta.json is ignored", () => {
    const t = session([], {
      "agent-a.jsonl": [user, asst("a1", 100, 1000)],
      "agent-a.meta.json": [{ agentType: "Explore" }],
      "workflows/wf_1/agent-b.jsonl": [user, asst("b1", 50)],
    });
    expect(subagentTokens(t)).toEqual({ inputTokens: 2, outputTokens: 150, cacheCreationTokens: 0, cacheReadTokens: 1000, apiCalls: 2 });
  });

  test("records of one response (shared message.id) count once", () => {
    const t = session([], { "agent-a.jsonl": [user, asst("m", 300), asst("m", 300), asst("m", 300)] });
    expect(subagentTokens(t)).toMatchObject({ outputTokens: 300, apiCalls: 1 });
  });

  test("an appended file is read on from the cache and ends where a full read would", () => {
    const t = session([], { "agent-a.jsonl": [user, asst("m1", 100)] });
    const f = path.join(path.dirname(t), "sess", "subagents", "agent-a.jsonl");
    expect(subagentTokens(t)!.outputTokens).toBe(100);
    // A duplicate of m1 straddling the incremental boundary, then a half-written record…
    fs.appendFileSync(f, JSON.stringify(asst("m1", 100)) + "\n" + JSON.stringify(asst("m2", 40)).slice(0, 20));
    expect(subagentTokens(t)).toMatchObject({ outputTokens: 100, apiCalls: 1 });
    // …which counts once it is complete.
    fs.writeFileSync(f, jsonl([user, asst("m1", 100), asst("m1", 100), asst("m2", 40)]));
    expect(subagentTokens(t)).toMatchObject({ outputTokens: 140, apiCalls: 2 });
  });

  test("a file that shrank is re-read from the start", () => {
    const t = session([], { "agent-a.jsonl": [user, asst("m1", 100), asst("m2", 200)] });
    expect(subagentTokens(t)!.outputTokens).toBe(300);
    fs.writeFileSync(path.join(path.dirname(t), "sess", "subagents", "agent-a.jsonl"), jsonl([asst("x", 7)]));
    expect(subagentTokens(t)!.outputTokens).toBe(7);
  });

  test("no transcript or no subagents folder → null, never a throw", () => {
    expect(subagentTokens(undefined)).toBeNull();
    expect(subagentTokens(session([user], {}))).toBeNull();
  });
});

describe("tokens.session with subagents", () => {
  const mainChain = [{ type: "user", timestamp: "2026-09-28T10:00:00.000Z", message: { role: "user", content: "hi" } }, { ...asst("main1", 1000), isSidechain: false }];
  const widget = (options: Record<string, unknown> = {}) => ({ widget: "tokens.session", options: { breakdown: false, ...options } });

  test("the total includes subagents by default and leaves them out when switched off", async () => {
    const t = session(mainChain, { "agent-a.jsonl": [user, asst("s1", 2000)] });
    const payload = { session_id: `sub-${n}`, transcript_path: t };
    expect(await renderWidget(payload, widget())).toBe("Tokens 3k");
    expect(await renderWidget(payload, widget({ subagents: false }))).toBe("Tokens 1k");
  });

  test("a reset nets main and subagent tokens against their own baselines", async () => {
    const t = session(mainChain, { "agent-a.jsonl": [user, asst("s1", 2000)] });
    const id = `sub-reset-${n}`;
    writeBaseline(id, baselineFrom({} as never, { inputTokens: 1, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, apiCalls: 1 }, 0, subagentTokens(t)));
    fs.appendFileSync(path.join(path.dirname(t), "sess", "subagents", "agent-b.jsonl"), jsonl([user, asst("s2", 500)]));
    expect(await renderWidget({ session_id: id, transcript_path: t }, widget())).toBe("Tokens 501");
  });

  test("a baseline written before subagents were counted reads their baseline as zero", () => {
    const id = "sub-old-baseline";
    writeBaseline(id, { at: 1, costUsd: 0, apiMs: 0, linesAdded: 0, linesRemoved: 0, tokens: { inputTokens: 0, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 } } as never);
    const sub = { inputTokens: 0, outputTokens: 70, cacheCreationTokens: 0, cacheReadTokens: 0, apiCalls: 1 };
    expect(netTokens(sub, readBaseline(id), "subagentTokens")).toEqual(sub);
  });
});
