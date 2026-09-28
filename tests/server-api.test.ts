/**
 * The HTTP contract the web panel is built against. Every test runs in a sandboxed HOME /
 * CLAUDE_CONFIG_DIR, through handleRequest (no socket).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME } from "../src/data/app-name.ts";
import { PREVIOUS_KEY, settingsPath } from "../src/server/install.ts";
import { handleRequest } from "../src/server/serve.ts";
import { enterSandbox, writeSample, type Sandbox } from "./server-sandbox.ts";

const PORT = 4877;
function call(pathname: string, method = "GET", body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleRequest(new Request(`http://127.0.0.1:${PORT}${pathname}`, init), PORT);
}

const HUD = { type: "command", command: "bash -c 'exec bun ~/.claude/plugins/cache/claude-hud/claude-hud/1.2.0/src/index.ts'" };
let sb: Sandbox;
beforeAll(() => {
  sb = enterSandbox();
});
afterEach(() => fs.rmSync(path.dirname(settingsPath()), { recursive: true, force: true }));
afterAll(() => sb.restore());

describe("samples and paths", () => {
  test("GET /api/samples: live first (newest first, one per session) with project/model metadata, fixtures last", async () => {
    const proj = path.join(sb.root, "repo-a");
    writeSample(sb.claudeDir, "older", { workspace: { current_dir: proj }, model: { display_name: "Sonnet 5" } }, 1_000);
    writeSample(sb.claudeDir, "newer", { workspace: { current_dir: proj }, model: { display_name: "Opus 5.5" } }, 2_000);
    // Same session captured under a second file name must not show twice.
    const dup = path.join(sb.claudeDir, "plugins", APP_NAME, "samples", "newer-copy.json");
    fs.writeFileSync(dup, JSON.stringify({ capturedAt: 1_500, payload: { session_id: "newer", workspace: { current_dir: proj } } }));
    const list = (await (await call("/api/samples")).json()) as Array<Record<string, unknown>>;
    const live = list.filter((s) => s.source === "live");
    expect(live.map((s) => s.sessionId)).toEqual(["newer", "older"]);
    expect(live[0]).toMatchObject({ id: "newer", cwd: proj, project: "repo-a", model: "Opus 5.5", capturedAt: 2_000 });
    const fixtures = list.filter((s) => s.source === "fixture");
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures[0]).toMatchObject({ sessionId: null, cwd: null, project: null });
    expect(list.indexOf(fixtures[0]!)).toBeGreaterThan(list.indexOf(live[live.length - 1]!));
  });

  test("GET /api/config reports the real samples dir and data dir (they follow CLAUDE_CONFIG_DIR)", async () => {
    const { paths } = (await (await call("/api/config")).json()) as { paths: Record<string, string> };
    expect(paths.dataDir).toBe(path.join(sb.claudeDir, "plugins", APP_NAME));
    expect(paths.samples).toBe(path.join(sb.claudeDir, "plugins", APP_NAME, "samples"));
  });
});

describe("render batch", () => {
  const probe = (text: string) => ({ colorLevel: "none", lines: [{ left: [{ widget: "custom.text", options: { text } }] }] });

  test("returns one result per config, in order, matching single renders", async () => {
    const res = await call("/api/render/batch", "POST", { sampleId: null, columns: 0, configs: [probe("alpha"), probe("beta"), probe("gamma")] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<{ lines: string[] }> };
    expect(results.map((r) => r.lines[0])).toEqual(["alpha", "beta", "gamma"]);
    const single = (await (await call("/api/render", "POST", { sampleId: null, columns: 0, config: probe("beta") })).json()) as { lines: string[] };
    expect(single.lines).toEqual(results[1]!.lines);
  });

  test("rejects an empty or oversized batch", async () => {
    expect((await call("/api/render/batch", "POST", { configs: [] })).status).toBe(400);
    expect((await call("/api/render/batch", "POST", { configs: Array.from({ length: 101 }, () => probe("x")) })).status).toBe(400);
    expect((await call("/api/render/batch", "POST", { configs: "nope" })).status).toBe(400);
  });
});

describe("install API", () => {
  test("GET /api/install describes current, planned and saved-previous", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: HUD }));
    const plan = (await (await call("/api/install")).json()) as Record<string, unknown>;
    expect(plan).toMatchObject({ settingsFile: settingsPath(), current: HUD, previous: HUD, currentIsOurs: false, savedPrevious: null });
    expect((plan.planned as { command: string }).command).toContain("render");
  });

  test("POST /api/install over a foreign statusline is a 409 until confirmed", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: HUD }));
    const first = await call("/api/install", "POST", {});
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: "needs-confirm", current: HUD });
    const confirmed = await call("/api/install", "POST", { confirmReplace: true });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ settingsFile: settingsPath(), replaced: HUD });
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))[PREVIOUS_KEY]).toEqual(HUD);
  });

  test("POST /api/install on empty settings needs no confirmation", async () => {
    const r = await call("/api/install", "POST", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ replaced: null });
  });

  test("POST /api/uninstall restores the parked statusline, and is a no-op when the entry isn't ours", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: HUD }));
    expect(await (await call("/api/uninstall", "POST", {})).json()).toMatchObject({ removed: false, restored: null });
    await call("/api/install", "POST", { confirmReplace: true });
    expect(await (await call("/api/uninstall", "POST", {})).json()).toMatchObject({ removed: true, restored: HUD });
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({ statusLine: HUD });
  });

  test("a fresh install refreshes every 5 s; reinstalling keeps the user's own interval", async () => {
    await call("/api/install", "POST", {});
    const read = () => JSON.parse(fs.readFileSync(settingsPath(), "utf8")).statusLine;
    expect(read().refreshInterval).toBe(5);
    await call("/api/refresh-interval", "POST", { seconds: 30 });
    await call("/api/install", "POST", {});
    expect(read().refreshInterval).toBe(30);
  });

  test("POST /api/refresh-interval sets, clears and validates the interval on our entry only", async () => {
    const read = () => JSON.parse(fs.readFileSync(settingsPath(), "utf8")).statusLine;
    // Someone else's statusline is not ours to retime.
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: HUD }));
    expect((await call("/api/refresh-interval", "POST", { seconds: 5 })).status).toBe(400);
    expect(read()).toEqual(HUD);

    await call("/api/install", "POST", { confirmReplace: true });
    expect(await (await call("/api/refresh-interval", "POST", { seconds: 10 })).json()).toMatchObject({ refreshInterval: 10, unchanged: false });
    expect(read().refreshInterval).toBe(10);
    expect(await (await call("/api/refresh-interval", "POST", { seconds: 10 })).json()).toMatchObject({ unchanged: true, backup: null });
    expect(await (await call("/api/refresh-interval", "POST", { seconds: null })).json()).toMatchObject({ refreshInterval: null });
    expect("refreshInterval" in read()).toBe(false);
    // Below Claude Code's minimum, fractional, absurdly slow, or not a number at all.
    for (const seconds of [0, 1.5, 3601, "5", undefined]) {
      expect((await call("/api/refresh-interval", "POST", { seconds })).status).toBe(400);
    }
    expect("refreshInterval" in read()).toBe(false);
  });
});
