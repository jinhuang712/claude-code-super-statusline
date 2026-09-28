import { defineWidget, type Ctx, type Segment, type WidgetApi } from "../core/types.js";
import type { FileStats } from "../data/git.js";
import { stdin } from "./_shared.js";

/**
 * The branch and its dirty marker. Ahead/behind and the file stats moved to Changes
 * (git.linesChanged) in config version 2; old configs are carried over by migrateGitBranchParts.
 */
export const gitBranch = defineWidget<{ showDirty: boolean; prefix: string; parens: boolean; link: boolean }>({
  id: "git.branch",
  name: "Git branch",
  description: "Branch with a dirty marker. Ahead/behind and file stats are in Changes.",
  category: "git",
  sample: "git:(main*)",
  schema: {
    type: "object",
    properties: {
      prefix: { type: "string", default: "git:", title: "Prefix" },
      parens: { type: "boolean", default: true, title: "Branch in parentheses" },
      showDirty: { type: "boolean", default: true, title: "Show * when dirty" },
      link: { type: "boolean", default: true, title: "Link branch to GitHub" },
    },
  },
  defaults: { prefix: "git:", parens: true, showDirty: true, link: true },
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

/** How git.linesChanged lists the changed files; "breakdown" is the pre-release name of "letters". */
type FilesStyle = "off" | "total" | "letters" | "symbols" | "breakdown";

/**
 * The changed-files part of git.linesChanged, from `git status`. Always the worktree, whatever
 * `source` the lines use: Claude Code reports lines per session but no files.
 *   total    "4 files"
 *   letters  "4 files A1 M2 D1 R1" — git's own status letters; untracked files count as added
 *            (new files that just haven't been `git add`ed), and M excludes renames so each file
 *            is counted once.
 *   symbols  "!2 +1 ✘1 ?1 →1" — the notation git.branch used to show (modified, staged added,
 *            deleted, untracked), one warn-coloured run as it was there; →N for renames is new.
 */
function changedFiles(f: FileStats | undefined, style: FilesStyle, api: WidgetApi): Segment[] {
  if (!f || style === "off") return [];
  const renamed = f.renamed ?? 0;
  const modified = Math.max(0, f.modified - renamed);
  if (style === "symbols") {
    const bits = [modified ? `!${modified}` : "", f.added ? `+${f.added}` : "", f.deleted ? `✘${f.deleted}` : "", f.untracked ? `?${f.untracked}` : "", renamed ? `→${renamed}` : ""].filter(Boolean);
    return bits.length ? [api.seg(bits.join(" "), { fg: "warn" })] : [];
  }
  const parts: Array<[string, number, string]> = [
    ["A", f.added + f.untracked, "ok"],
    ["M", modified, "warn"],
    ["D", f.deleted, "crit"],
    ["R", renamed, "accent"],
  ];
  const total = parts.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return [];
  const segs = [api.seg(`${total} ${total === 1 ? "file" : "files"}`, { fg: "muted" })];
  if (style !== "total") for (const [letter, c, fg] of parts) if (c) segs.push(api.seg(` ${letter}${c}`, { fg }));
  return segs;
}

/** Commits ahead of / behind the upstream, as git.branch used to show them: "↑2 ↓1". */
function aheadBehind(ctx: Ctx, api: WidgetApi): Segment[] {
  const g = ctx.gitStatus;
  if (!g || (g.ahead <= 0 && g.behind <= 0)) return [];
  return [api.seg([g.ahead > 0 ? `↑${g.ahead}` : "", g.behind > 0 ? `↓${g.behind}` : ""].filter(Boolean).join(" "), { fg: "muted" })];
}

/**
 * "Changes" in the panel. The id stays git.linesChanged so saved configs keep working; it took over
 * ahead/behind and the file stats from git.branch in config version 2 (see migrateGitBranchParts).
 */
export const gitLines = defineWidget<{ lines: boolean; source: "session" | "worktree"; files: FilesStyle; aheadBehind: boolean; hideZero: boolean }>({
  id: "git.linesChanged",
  name: "Changes",
  description:
    "What changed: lines added/removed (this session's edits, or what is uncommitted in the worktree), the changed files from git status, and commits ahead of/behind the upstream.",
  category: "git",
  sample: "+156 -23 · 4 files A1 M2 D1 · ↑2",
  schema: {
    type: "object",
    properties: {
      lines: { type: "boolean", default: true, title: "Show +N -N lines" },
      source: { type: "string", enum: ["session", "worktree"], default: "session", title: "Count", "x-requires": { lines: true } },
      files: {
        type: "string",
        enum: ["off", "total", "letters", "symbols"],
        default: "off",
        title: "Changed files",
        description: "From git status: 4 files · 4 files A1 M2 D1 R1 · !2 +1 ✘1 ?1 →1",
      },
      aheadBehind: { type: "boolean", default: false, title: "Show ↑N ↓N" },
      hideZero: { type: "boolean", default: true, title: "Hide when both are zero", "x-requires": { lines: true } },
    },
  },
  defaults: { lines: true, source: "session", files: "off", aheadBehind: false, hideZero: true },
  sampleFor(o) {
    // Only the parts this instance shows, in the order render() puts them.
    const files = { off: "", total: "4 files", letters: "4 files A1 M2 D1", breakdown: "4 files A1 M2 D1", symbols: "!2 +1 ✘1 ?1" }[o.files] ?? "";
    return [o.lines ? "+156 -23" : "", files, o.aheadBehind ? "↑2" : ""].filter(Boolean).join(" · ");
  },
  render(ctx, o, api) {
    // Each part hides itself when empty; the widget hides when all of them are.
    const parts = [o.lines ? renderLines(ctx, o, api) : null, changedFiles(ctx.gitStatus?.fileStats, o.files, api), o.aheadBehind ? aheadBehind(ctx, api) : []].filter(
      (p): p is Segment[] => !!p && p.length > 0,
    );
    if (!parts.length) return null;
    return parts.flatMap((p, i) => (i ? [api.seg(" · ", { fg: "muted" }), ...p] : p));
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
