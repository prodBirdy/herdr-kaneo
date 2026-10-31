// Which git repo each Kaneo project works in. Pure helpers, no Herdr imports, so `node --test` loads it.

export const DEFAULT_ROOTS = ["~/Projects", "~/projects", "~/dev", "~/code", "~/src", "~/repos", "~/git", "~/work", "~/Developer"];

// The shell scan: every git checkout up to three folders under each root, as
// `<folder>\t<1 if a main checkout, 0 if a worktree>\t<origin url>`, plus `root\t<folder>` per root that exists.
export const SCAN_SCRIPT = `for root in "$@"; do
  [ -d "$root" ] || continue
  printf 'root\\t%s\\n' "$root"
  find "$root" -maxdepth 3 \\( -name node_modules -o -name .cache -o -name target \\) -prune -o -name .git -print -prune 2>/dev/null
done | while IFS= read -r line; do
  case "$line" in root*) printf '%s\\n' "$line"; continue;; esac
  d=\${line%/.git}; [ -d "$line" ] && m=1 || m=0
  printf '%s\\t%s\\t%s\\n' "$d" "$m" "$(git -C "$d" remote get-url origin 2>/dev/null)"
done`;

const expand = (path, home) => (path.startsWith("~/") ? `${home}${path.slice(1)}` : path);
export const scanRoots = (config, home) => (config.repoRoots?.length ? config.repoRoots : DEFAULT_ROOTS).map((r) => expand(r, home));

// A remote without its credentials, as `host/owner/name` in lower case, for comparing:
// git@github.com:o/n.git, https://user:token@github.com/o/n, ssh://git@github.com/o/n.
export function remoteKey(url) {
  if (!url) return null;
  let s = String(url).trim();
  const scp = /^[^/@:]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]*@/, "");
  s = s.replace(/:\d+\//, "/").replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return s.includes("/") ? s.toLowerCase() : null;
}

// A remote safe to show: no user, password or token.
export function displayRemote(url) {
  const key = remoteKey(url);
  return key ?? "";
}

// Lines from SCAN_SCRIPT → { roots, repos: [{ path, name, main, remote }] }; credentials are never kept.
export function parseScan(out) {
  const roots = [], repos = [];
  for (const line of String(out ?? "").split("\n")) {
    const [a, b, c] = line.split("\t");
    if (!a) continue;
    if (a === "root") { if (b) roots.push(b); continue; }
    repos.push({ path: a, name: a.split("/").pop(), main: b === "1", remote: remoteKey(c) });
  }
  repos.sort((x, y) => Number(y.main) - Number(x.main) || x.name.localeCompare(y.name));
  return { roots, repos };
}

// Kaneo's GitHub / GitLab / Gitea link for a project → { provider, key, cloneUrl, label, branchPattern } or null.
export function linkFrom(provider, json) {
  if (!json || json.isActive === false) return null;
  let host, path;
  if (provider === "github" && json.repositoryOwner && json.repositoryName) {
    host = "github.com"; path = `${json.repositoryOwner}/${json.repositoryName}`;
  } else if (provider === "gitea" && json.baseUrl && json.repositoryOwner && json.repositoryName) {
    host = remoteKey(`${json.baseUrl}/x`)?.replace(/\/x$/, ""); path = `${json.repositoryOwner}/${json.repositoryName}`;
  } else if (provider === "gitlab" && json.baseUrl && json.projectPath) {
    host = remoteKey(`${json.baseUrl}/x`)?.replace(/\/x$/, ""); path = json.projectPath;
  }
  if (!host || !path) return null;
  return {
    provider, key: `${host}/${path}`.toLowerCase(), label: path,
    cloneUrl: provider === "github" ? `git@github.com:${path}.git` : `${String(json.baseUrl).replace(/\/+$/, "")}/${path}.git`,
    branchPattern: json.branchPattern ?? null,
  };
}

const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The best local checkout of `key`: a main checkout named like the repo, else any main one, else a worktree.
function localClone(repos, key) {
  const name = key.split("/").pop();
  const same = repos.filter((r) => r.remote === key);
  return same.find((r) => r.main && r.name.toLowerCase() === name) ?? same.find((r) => r.main) ?? same[0] ?? null;
}

// Where a project's agents work: { cwd, clone?, source } or null (ask).
//   saved   the repo picked in the panel, { cwd, clone? }
//   mapped  kaneo.json `repos` for its slug
//   link    Kaneo's git link (linkFrom)
export function resolveRepo(project, { saved, mapped, link, repos, cloneRoot }) {
  if (saved?.cwd) return { cwd: saved.cwd, clone: saved.clone ?? null, source: saved.clone ? "picked, clone" : "picked" };
  if (mapped) return { cwd: mapped, clone: null, source: "kaneo.json" };
  if (link) {
    const local = localClone(repos, link.key);
    if (local) return { cwd: local.path, clone: null, source: `Kaneo ${link.provider} link` };
    if (cloneRoot) return { cwd: `${cloneRoot}/${link.key.split("/").pop()}`, clone: link.cloneUrl, source: `clone from Kaneo ${link.provider} link` };
  }
  const names = [slugify(project.name), slugify(project.slug)].filter(Boolean);
  const named = repos.find((r) => r.main && (names.includes(slugify(r.name)) || names.includes(slugify(r.remote?.split("/").pop()))));
  if (named) return { cwd: named.path, clone: null, source: "name match" };
  return null;
}

// A git URL someone typed to clone: no options, no spaces; https, ssh or scp-like.
export function cloneProblem(url) {
  const s = String(url ?? "").trim();
  if (!s) return "Enter a git URL";
  if (s.startsWith("-") || /\s/.test(s)) return "Not a git URL";
  if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(s) || !remoteKey(s)) return "Use an https://, ssh:// or git@host:owner/repo URL";
  return null;
}
