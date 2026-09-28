import { defineWidget, type Ctx, type Segment, type WidgetApi } from "../core/types.js";
import type { FileStats } from "../data/git.js";
import { stdin } from "./_shared.js";

export const gitBranch = defineWidget<{ showDirty: boolean; showAheadBehind: boolean; showFileStats: boolean; prefix: string; parens: boolean; link: boolean }>({
  id: "git.branch",
  name: "Git branch",
  description: "Branch with dirty marker, ahead/behind and file stats.",
  category: "git",
  sample: "git:(main*) ↑2 !3 +1",
  schema: {
    type: "object",
    properties: {
      prefix: { type: "string", default: "git:", title: "Prefix" },
      parens: { type: "boolean", default: true, title: "Branch in parentheses" },
      showDirty: { type: "boolean", default: true, title: "Show * when dirty" },
      showAheadBehind: { type: "boolean", default: true, title: "Show ↑N ↓N" },
      showFileStats: { type: "boolean", default: false, title: "Show !M +A ✘D ?U" },
      link: { type: "boolean", default: true, title: "Link branch to GitHub" },
    },
  },
  defaults: { prefix: "git:", parens: true, showDirty: true, showAheadBehind: true, showFileStats: false, link: true },
  render(ctx, o, api) {
    const g = ctx.gitStatus;
    if (!g) {
      // Not a repo (or git disabled): keep the label so the line reads
      // `git:(—)` instead of a bare `—` with no context.
      if (!o.prefix) return [api.seg("—", { fg: "muted" })];
      if (o.parens)
        return [api.seg(`${o.prefix}(`, { fg: "git" }), api.seg("—", { fg: "muted" }), api.seg(")", { fg: "git" })];
      return [api.seg(`${o.prefix} `, { fg: "git" }), api.seg("—", { fg: "muted" })];
    }
    const segs = [];
    const kind = g.vcs === "jj" ? "jj:" : o.prefix;
    if (kind) segs.push(api.seg(o.parens ? `${kind}(` : `${kind} `, { fg: "git" }));
    const branch = api.seg(`${g.branch}${o.showDirty && g.isDirty ? "*" : ""}`, { fg: "accent" });
    if (o.link && g.branchUrl) branch.link = g.branchUrl;
    segs.push(branch);
    if (g.conflict) segs.push(api.seg(" !conflict", { fg: "crit" }));
    if (kind && o.parens) segs.push(api.seg(")", { fg: "git" }));
    if (o.showAheadBehind && (g.ahead > 0 || g.behind > 0)) {
      const ab = [g.ahead > 0 ? `↑${g.ahead}` : "", g.behind > 0 ? `↓${g.behind}` : ""].filter(Boolean).join(" ");
      segs.push(api.seg(` ${ab}`, { fg: "muted" }));
    }
    if (o.showFileStats && g.fileStats) {
      const f = g.fileStats;
      const bits = [f.modified ? `!${f.modified}` : "", f.added ? `+${f.added}` : "", f.deleted ? `✘${f.deleted}` : "", f.untracked ? `?${f.untracked}` : ""].filter(Boolean);
      if (bits.length) segs.push(api.seg(` ${bits.join(" ")}`, { fg: "warn" }));
    }
    return segs;
  },
});

export const gitRepo = defineWidget<{ format: "owner/name" | "name" }>({
  id: "git.repo",
  name: "Repository",
  description: "owner/name of the origin remote (from Claude Code, or read from .git/config when it isn't sent).",
  category: "git",
  sample: "acme/webapp",
  schema: { type: "object", properties: { format: { type: "string", enum: ["owner/name", "name"], default: "owner/name" } } },
  defaults: { format: "owner/name" },
  render(ctx, o, api) {
    const r = stdin(ctx).workspace?.repo ?? ctx.originRepo;
    if (!r?.name) return null;
    const text = o.format === "name" || !r.owner ? r.name : `${r.owner}/${r.name}`;
    const seg = api.seg(text, { fg: "git" });
    if (r.host && r.owner) seg.link = `https://${r.host}/${r.owner}/${r.name}`;
    return [seg];
  },
});

export const gitPr = defineWidget<{ showState: boolean }>({
  id: "git.pr",
  name: "Pull request",
  description: "Open PR/MR for the current branch with review state.",
  category: "git",
  sample: "#1234 ✓approved",
  schema: { type: "object", properties: { showState: { type: "boolean", default: true, title: "Show review state" } } },
  defaults: { showState: true },
  render(ctx, o, api) {
    const pr = stdin(ctx).pr;
    if (!pr?.number) return null;
    const stateGlyph: Record<string, string> = { approved: "✓", pending: "…", changes_requested: "✗", draft: "◌" };
    const stateColor: Record<string, string> = { approved: "ok", pending: "muted", changes_requested: "crit", draft: "muted" };
    const segs = [api.seg(`${pr.kind === "mr" ? "!" : "#"}${pr.number}`, { fg: "accent" })];
    if (pr.url) segs[0]!.link = pr.url;
    if (o.showState && pr.review_state) {
      segs.push(api.seg(` ${stateGlyph[pr.review_state] ?? ""}${pr.review_state.replace("_", " ")}`, { fg: stateColor[pr.review_state] ?? "muted" }));
    }
    return segs;
  },
});

/**
 * The changed-files part of git.linesChanged, from `git status`: "4 files" or "4 files A1 M2 D1 R1".
 * Always the worktree, whatever `source` the lines use: Claude Code reports lines per session but no
 * files. A/M/D/R are git's own status letters; untracked files count as added (they are new files
 * that just haven't been `git add`ed), and M excludes renames so each file is counted once.
 */
function changedFiles(f: FileStats | undefined, breakdown: boolean, api: WidgetApi): Segment[] {
  if (!f) return [];
  const renamed = f.renamed ?? 0;
  const parts: Array<[string, number, string]> = [
    ["A", f.added + f.untracked, "ok"],
    ["M", Math.max(0, f.modified - renamed), "warn"],
    ["D", f.deleted, "crit"],
    ["R", renamed, "accent"],
  ];
  const total = parts.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return [];
  const segs = [api.seg(`${total} ${total === 1 ? "file" : "files"}`, { fg: "muted" })];
  if (breakdown) for (const [letter, c, fg] of parts) if (c) segs.push(api.seg(` ${letter}${c}`, { fg }));
  return segs;
}

export const gitLines = defineWidget<{ source: "session" | "worktree"; files: "off" | "total" | "breakdown"; hideZero: boolean }>({
  id: "git.linesChanged",
  name: "Lines changed",
  description: "Lines added/removed: either what this session edited (Claude Code's count) or what is uncommitted in the worktree (git diff HEAD). Can add the changed files from git status.",
  category: "git",
  sample: "+156 -23",
  schema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["session", "worktree"], default: "session", title: "Count" },
      files: {
        type: "string",
        enum: ["off", "total", "breakdown"],
        default: "off",
        title: "Changed files",
        description: "From git status: 4 files, or 4 files A1 M2 D1 R1 (added, modified, deleted, renamed)",
      },
      hideZero: { type: "boolean", default: true, title: "Hide when both are zero" },
    },
  },
  defaults: { source: "session", files: "off", hideZero: true },
  render(ctx, o, api) {
    const lines = renderLines(ctx, o, api);
    const files = o.files === "off" ? [] : changedFiles(ctx.gitStatus?.fileStats, o.files === "breakdown", api);
    if (!lines && !files.length) return null;
    if (!lines) return files;
    return files.length ? [...lines, api.seg(" · ", { fg: "muted" }), ...files] : lines;
  },
});

/** The +added -removed part; null when there is nothing to show (see hideZero). */
function renderLines(ctx: Ctx, o: { source: "session" | "worktree"; hideZero: boolean }, api: WidgetApi): Segment[] | null {
  let add = 0;
  let del = 0;
  if (o.source === "worktree") {
    // No repo → no worktree diff: hide instead of emitting a bare `—`.
    if (!ctx.gitStatus) return null;
    add = ctx.gitStatus.lineDiff?.added ?? 0;
    del = ctx.gitStatus.lineDiff?.deleted ?? 0;
  } else {
    const c = stdin(ctx).cost;
    add = Math.max(0, (c?.total_lines_added ?? 0) - (ctx.reset?.linesAdded ?? 0));
    del = Math.max(0, (c?.total_lines_removed ?? 0) - (ctx.reset?.linesRemoved ?? 0));
  }
  if (o.hideZero && !add && !del) return null;
  return [api.seg(`+${add}`, { fg: "ok" }), api.seg(" "), api.seg(`-${del}`, { fg: "crit" })];
}
