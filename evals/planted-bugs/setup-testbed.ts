/**
 * Builds the shop-api test repository and opens one PR per case.
 *
 *   npx tsx evals/planted-bugs/setup-testbed.ts --repo <owner>/shop-api-review-evals
 *   npx tsx evals/planted-bugs/setup-testbed.ts --local-only     # branches only, no GitHub
 *
 * Writes evals/planted-bugs/ground-truth.json (case → PR number, bug file/lines).
 * Requires `gh` to be authenticated when not --local-only. The repo is created private.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUG_MARKER, cases, type Case } from "./cases";

const HERE = resolve(__dirname);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const localOnly = flag("--local-only");
const repo = opt("--repo", "");
const workdir = resolve(opt("--dir", join(HERE, ".testbed")));
if (!localOnly && !/^[^/]+\/[^/]+$/.test(repo)) throw new Error("Pass --repo owner/name (or --local-only).");

function run(cmd: string, cmdArgs: string[], cwd = workdir): string {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const git = (...a: string[]) => run("git", a);
const gh = (...a: string[]) => run("gh", a);

export interface GroundTruth {
  repo: string | null;
  createdAt: string;
  cases: Array<{
    id: string;
    kind: Case["kind"];
    title: string;
    branch: string;
    prNumber: number | null;
    expected: string;
    bugs: Array<{ file: string; lines: number[] }>;
  }>;
}

function applyCase(c: Case): Array<{ file: string; lines: number[] }> {
  const touched = new Map<string, string>();
  const read = (p: string) => touched.get(p) ?? (existsSync(join(workdir, p)) ? readFileSync(join(workdir, p), "utf8") : "");
  for (const e of c.edits) {
    let next: string;
    if ("content" in e) next = e.content;
    else if ("append" in e) next = read(e.path).replace(/\n*$/, "\n") + e.append;
    else {
      const cur = read(e.path);
      if (!cur.includes(e.replace[0])) throw new Error(`${c.id}: replace target not found in ${e.path}`);
      next = cur.replace(e.replace[0], e.replace[1]);
    }
    touched.set(e.path, next);
  }
  const bugs: Array<{ file: string; lines: number[] }> = [];
  for (const [path, content] of touched) {
    const lines = content.split("\n");
    const bugLines: number[] = [];
    const clean = lines.map((l, i) => {
      if (BUG_MARKER.test(l)) {
        bugLines.push(i + 1);
        return l.replace(BUG_MARKER, "");
      }
      return l;
    });
    mkdirSync(dirname(join(workdir, path)), { recursive: true });
    writeFileSync(join(workdir, path), clean.join("\n"));
    if (bugLines.length) bugs.push({ file: path, lines: bugLines });
  }
  if (c.kind !== "clean" && bugs.length === 0) throw new Error(`${c.id}: no @bug marker`);
  if (c.kind === "clean" && bugs.length > 0) throw new Error(`${c.id}: clean case has @bug marker`);
  return bugs;
}

function main() {
  rmSync(workdir, { recursive: true, force: true });
  cpSync(join(HERE, "fixtures/base"), workdir, { recursive: true });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=eval-bot", "-c", "user.email=eval-bot@users.noreply.github.com", "commit", "-qm", "Initial shop-api service");

  if (!localOnly) {
    let exists = true;
    try { gh("repo", "view", repo, "--json", "name"); } catch { exists = false; }
    if (!exists) gh("repo", "create", repo, "--private", "--description", "Test bed for AI PR-review evals (planted bugs, not real code)");
    git("remote", "add", "origin", `https://github.com/${repo}.git`);
    git("push", "-q", "-f", "origin", "main");
  }

  const truth: GroundTruth = { repo: localOnly ? null : repo, createdAt: new Date().toISOString(), cases: [] };
  for (const c of cases) {
    const branch = `eval/${c.id}`;
    git("checkout", "-q", "-B", branch, "main");
    const bugs = applyCase(c);
    git("add", "-A");
    git("-c", "user.name=eval-bot", "-c", "user.email=eval-bot@users.noreply.github.com", "commit", "-qm", c.title);

    let prNumber: number | null = null;
    if (!localOnly) {
      git("push", "-q", "-f", "origin", branch);
      const existing = JSON.parse(gh("pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number")) as Array<{ number: number }>;
      if (existing[0]) prNumber = existing[0].number;
      else {
        const url = gh("pr", "create", "-R", repo, "--base", "main", "--head", branch, "--title", c.title, "--body", c.body);
        prNumber = Number(url.split("/").pop());
      }
    }
    truth.cases.push({ id: c.id, kind: c.kind, title: c.title, branch, prNumber, expected: c.expected, bugs });
    console.log(`${c.id.padEnd(30)} ${prNumber ? `PR #${prNumber}` : branch}  bugs=${JSON.stringify(bugs)}`);
  }
  git("checkout", "-q", "main");
  writeFileSync(join(HERE, "ground-truth.json"), JSON.stringify(truth, null, 2) + "\n");
  console.log(`\nWrote ground-truth.json (${truth.cases.length} cases)`);
}

main();
