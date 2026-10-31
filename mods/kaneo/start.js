// Starting an agent on a Kaneo task: a worktree for its branch, then a space running the agent.
// Shared by the panel (Start, no questions) and the kaneo-agent dialog. Mods can't import across
// folders, so mods/kaneo-agent has a copy of this file, task.js and agents.js: edit them here and copy.

import { exec, home, knownAgents, shared } from "herdr";
import { adapterFor } from "./agents.js";
import { worktreeFolder, branchProblem, checkoutOf, taskFor } from "./task.js";

// The dialog's last choice, which Start reuses: { agent, model, effort, subagents, skill }.
export const LAST_CHOICE = "kaneo-agent.last";

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

async function userHome(on) {
  if (!on) return home();
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error("Could not find the remote home folder.");
  return r.stdout.trim();
}

// origin's default branch: origin/HEAD (set by clone), else main or master.
async function defaultBranch(cwd, on) {
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], on);
  if (head.ok) return head.out.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if ((await git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`], on)).ok) return name;
  }
  return "";
}

// origin/<default branch>, fetched; HEAD when there's no origin to fetch from.
async function baseRef(cwd, on) {
  const name = await defaultBranch(cwd, on);
  if (!name || !(await git(cwd, ["fetch", "origin", name], on)).ok) return "HEAD";
  return `origin/${name}`;
}

// The main checkout of the repo `cwd` is in, so a worktree made from another worktree lands beside the rest.
async function mainCheckout(cwd, on) {
  if (!cwd) throw new Error("Open a space in a git repo, or map this project in kaneo.json");
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!common.ok) throw new Error(`Not a git repository: ${cwd}`);
  return common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
}

// A local branch as it is; one only on origin tracks it; a new one starts from the default branch.
async function addArgs(main, on, branch, path) {
  if ((await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on)).ok) return ["worktree", "add", path, branch];
  if ((await git(main, ["fetch", "origin", branch], on)).ok) return ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`];
  return ["worktree", "add", "-b", branch, path, await baseRef(main, on)];
}

// Herdr's own worktree path, so the spaces sidebar nests it and Herdr's worktree dialog can remove it.
// A branch already checked out (in the main checkout or another worktree) is worked on there: git
// allows one checkout per branch. { folder, existing }.
export async function createWorktree(cwd, on, branch, identifier) {
  const problem = branchProblem(branch);
  if (problem) throw new Error(problem);
  const main = await mainCheckout(cwd, on);
  if (!(await git(main, ["check-ref-format", "--branch", branch], on)).ok) throw new Error(`Not a valid branch name: ${branch}`);
  const checkout = checkoutOf((await git(main, ["worktree", "list", "--porcelain"], on)).out, branch);
  if (checkout) return { folder: checkout, existing: true };
  const path = `${await userHome(on)}/.herdr/worktrees/${main.split("/").pop()}/${worktreeFolder(branch, identifier)}`;
  const r = await git(main, await addArgs(main, on, branch, path), on);
  if (!r.ok) throw new Error(r.err.split("\n").pop() || "git worktree add failed");
  return { folder: path, existing: false };
}

export const agentArgv = (agent, model, effort) => [...agent.run, ...(adapterFor(agent)?.flags(model, effort) ?? [])];

// The dialog's last choice on this machine, else the first installed agent (Claude Code first)
// with its own defaults. { agent, model, effort, subagents, skill }.
export async function defaultChoice(on) {
  const agents = (await knownAgents({ on })).filter((a) => a.installed);
  const last = shared(LAST_CHOICE) ?? {};
  const agent = agents.find((a) => a.key === last.agent) ?? agents.find((a) => a.key === "claude") ?? agents[0];
  if (!agent) throw new Error("No agent installed on this machine");
  const same = last.agent === agent.key;
  return {
    agent, model: same ? last.model ?? null : null, effort: same ? last.effort ?? null : null,
    subagents: Boolean(last.subagents), skill: last.skill ?? "",
  };
}

// A repo picked or linked but not on this computer yet: clone it to `cwd` (once).
export async function ensureClone(cwd, on, url) {
  if (!url) return;
  if ((await git(cwd, ["rev-parse", "--git-dir"], on).catch(() => ({ ok: false }))).ok) return;
  if (url.startsWith("-")) throw new Error(`Not a git URL: ${url}`);
  const r = await exec("git", ["clone", "--", url, cwd], { on });
  if (r.code !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
}

// Makes the worktree (cloning the repo first when needed) and returns the `space.new` arguments
// for one task (not run yet).
export async function prepare(issue, { cwd, on, clone = null, branch, choice, instructions = "" }) {
  await ensureClone(cwd, on, clone);
  const { folder, existing } = await createWorktree(cwd, on, branch, issue.identifier);
  const task = taskFor(issue, branch, { subagents: choice.subagents, skill: choice.skill, instructions, existing });
  return { folder, machine: on, tab: issue.identifier, argv: agentArgv(choice.agent, choice.model, choice.effort), task };
}
