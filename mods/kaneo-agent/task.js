// Pure helpers for the agent dialog: the branch name and the task the agent starts with.
// No Herdr imports, so `node --test` can load this file.

const DESCRIPTION_MAX = 600;

const slug = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-");

// `pattern` ({slug}, {number}, {title}: kaneo.json's, else the project's Kaneo git link's), else `<slug>-<number>-<first five title
// words>`, which Kaneo's GitHub integration links back to the task with its default `{slug}-{number}`.
export function branchFor(issue, pattern = null) {
  const project = String(issue.project ?? "").toLowerCase(), title = slug(issue.title);
  if (pattern?.trim() && issue.number != null) {
    // Kaneo matches the pattern with anything after it, so a pattern without {title} keeps the title as a suffix.
    const full = pattern.includes("{title}") ? pattern.trim() : `${pattern.trim()}-{title}`;
    return full.replace("{slug}", project).replace("{number}", String(issue.number)).replace("{title}", title)
      .replace(/-+$/, "");
  }
  return [issue.identifier.toLowerCase(), title].filter(Boolean).join("-");
}

// One path segment for the worktree folder.
export const folderName = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// The worktree's folder; the issue's identifier when the branch leaves nothing usable ("", ".", "..").
export function worktreeFolder(branch, identifier) {
  const name = folderName(branch);
  return name.replace(/\./g, "") ? name : folderName(identifier);
}

// Why git can't take this branch name safely, or null. A leading "-" would reach
// `git branch` as an option through `git worktree add -b`; git check-ref-format does the rest.
export function branchProblem(branch) {
  if (!branch.trim()) return "The branch name is empty";
  if (branch.startsWith("-")) return 'A branch name cannot start with "-"';
  return null;
}

// Control characters (a carriage return, ctrl-c, escapes) would act on the agent's terminal.
const plain = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();

function summary(description) {
  const flat = plain(description);
  if (!flat) return null;
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX)}…` : flat;
}

// Where `branch` is checked out, from `git worktree list --porcelain` (the main checkout included), or null.
export function checkoutOf(porcelain, branch) {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

// Typed into the agent as one line: a newline would send it early. A skill (`/review`) goes
// first, where agents look for a command; the person's own instructions follow the issue.
// `existing`: the branch was already checked out there, so its work may be uncommitted.
export function taskFor(raw, rawBranch, { subagents, skill = "", instructions = "", existing = false }) {
  const issue = { identifier: plain(raw.identifier), title: plain(raw.title), url: plain(raw.url) };
  const branch = plain(rawBranch), about = summary(raw.description), command = plain(skill), extra = plain(instructions);
  return [
    command || null,
    `Work on Kaneo task ${issue.identifier}: ${issue.title} (${issue.url}).`,
    about ? `Summary: ${about}` : null,
    extra ? `Instructions: ${extra}` : null,
    "If you have Kaneo access (MCP or API), read the full task and its comments first.",
    existing ? `You are in an existing checkout of branch ${branch}; keep any uncommitted work in it.`
      : `You are in a fresh worktree on branch ${branch}.`,
    "Read the repo's AGENTS.md / CLAUDE.md before changing code.",
    subagents ? "Delegate exploration and verification to subagents where your tool supports them." : null,
    "Run the project's lint, typecheck and tests before committing.",
    `Commit with conventional commits, push the branch and open a PR that mentions ${issue.identifier}.`,
    "Do not merge or deploy.",
  ].filter(Boolean).join(" ");
}
