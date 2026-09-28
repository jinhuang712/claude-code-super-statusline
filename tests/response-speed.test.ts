/**
 * tokens.outputSpeed is measured from the transcript (src/core/response-speed.ts). These cases pin
 * the rules: request start = preceding user entry, a response spans all its entries, short replies
 * and subagent entries are skipped, and a tail read that starts mid-file still works. latestResponseSpeed
 * adds the session's subagent files (<session>/subagents/*.jsonl), each timed on its own chain.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lastResponseSpeed, latestResponseSpeed } from "../src/core/response-speed";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssp-speed-"));
const t0 = Date.parse("2026-09-23T10:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const user = (s: number) => ({ type: "user", timestamp: at(s), message: { role: "user", content: "go" } });
const asst = (s: number, id: string, out: number, extra: Record<string, unknown> = {}) => ({ type: "assistant", timestamp: at(s), message: { id, role: "assistant", usage: { output_tokens: out } }, ...extra });
function transcript(name: string, entries: unknown[], padBefore = 0): string {
  const f = path.join(dir, `${name}.jsonl`);
  const pad = padBefore ? `${JSON.stringify({ type: "system", timestamp: at(0), content: "x".repeat(padBefore) })}\n` : "";
  fs.writeFileSync(f, pad + entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return f;
}

describe("lastResponseSpeed", () => {
  test("output tokens over request start → last entry of the response", () => {
    // 1000 tokens, request at t=10, blocks written at t=15 and t=20 → 1000 / 10 s.
    const f = transcript("basic", [user(10), asst(15, "m1", 1000), asst(20, "m1", 1000)]);
    const r = lastResponseSpeed(f)!;
    expect(r.outputTokens).toBe(1000);
    expect(r.durationMs).toBe(10_000);
    expect(r.tokensPerSecond).toBeCloseTo(100);
  });

  test("the latest long-enough response wins; short replies are skipped", () => {
    const f = transcript("short", [user(0), asst(10, "long", 800), user(11), asst(13, "short", 50)]);
    expect(lastResponseSpeed(f)!.outputTokens).toBe(800);
    expect(lastResponseSpeed(f, 10)!.outputTokens).toBe(50);
  });

  test("subagent (sidechain) entries don't count", () => {
    const f = transcript("side", [user(0), asst(10, "main", 500), user(12, ), asst(14, "sub", 900, { isSidechain: true })]);
    expect(lastResponseSpeed(f)!.outputTokens).toBe(500);
  });

  test("works when only the tail is read (file larger than the tail window)", () => {
    const f = transcript("big", [user(100), asst(104, "m", 400)], 400 * 1024);
    expect(lastResponseSpeed(f)!.tokensPerSecond).toBeCloseTo(100);
  });

  test("sidechain mode reads a subagent's own file, where every record is a sidechain", () => {
    const side = { isSidechain: true };
    const f = transcript("own-side", [{ ...user(0), ...side }, asst(4, "s", 400, side)]);
    expect(lastResponseSpeed(f)).toBeNull();
    expect(lastResponseSpeed(f, undefined, true)!.tokensPerSecond).toBeCloseTo(100);
  });

  test("no transcript, no user entry, or no usage → null, never a throw", () => {
    expect(lastResponseSpeed(undefined)).toBeNull();
    expect(lastResponseSpeed(path.join(dir, "missing.jsonl"))).toBeNull();
    expect(lastResponseSpeed(transcript("nouser", [asst(5, "m", 900)]))).toBeNull();
    expect(lastResponseSpeed(transcript("garbage", ["{not json", user(0), { type: "assistant", timestamp: at(3), message: { id: "x" } }]))).toBeNull();
  });
});

describe("latestResponseSpeed", () => {
  const side = { isSidechain: true };
  /** A session with a main transcript and subagent files (name → entries), each given its own mtime. */
  function withSubagents(name: string, main: unknown[], subs: Record<string, { entries: unknown[]; mtime: number }>): string {
    const mainFile = transcript(name, main);
    for (const [sub, { entries, mtime }] of Object.entries(subs)) {
      const f = path.join(dir, name, "subagents", `${sub}.jsonl`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      fs.utimesSync(f, new Date(mtime), new Date(mtime));
    }
    return mainFile;
  }

  test("a subagent response newer than the main chain's is the one measured, timed on its own chain", () => {
    // Main request at 0 finishing at 10; the agent's own request at 20 finishing at 22 → 600 / 2 s.
    const f = withSubagents("sub-newer", [user(0), asst(10, "m", 500)], {
      "agent-a": { entries: [{ ...user(20), ...side }, asst(22, "s", 600, side)], mtime: t0 + 22_000 },
    });
    const r = latestResponseSpeed(f)!;
    expect(r.outputTokens).toBe(600);
    expect(r.tokensPerSecond).toBeCloseTo(300);
  });

  test("the main chain still wins when it answered last", () => {
    const f = withSubagents("main-newer", [user(0), asst(40, "m", 800)], {
      "agent-a": { entries: [{ ...user(20), ...side }, asst(22, "s", 600, side)], mtime: t0 + 22_000 },
    });
    expect(latestResponseSpeed(f)!.outputTokens).toBe(800);
  });

  test("subagent files last written before the best response found are not read", () => {
    // This file claims a later finish than its mtime allows; only the mtime cut-off keeps it out.
    const f = withSubagents("stale", [user(0), asst(40, "m", 800)], {
      "agent-old": { entries: [{ ...user(50), ...side }, asst(60, "s", 900, side)], mtime: t0 + 30_000 },
    });
    expect(latestResponseSpeed(f)!.outputTokens).toBe(800);
  });

  test("only subagents measured yet → their speed; nothing at all → null", () => {
    const f = withSubagents("only-sub", [user(0)], { "agent-a": { entries: [{ ...user(1), ...side }, asst(5, "s", 400, side)], mtime: t0 + 5_000 } });
    expect(latestResponseSpeed(f)!.outputTokens).toBe(400);
    expect(latestResponseSpeed(undefined)).toBeNull();
  });
});
