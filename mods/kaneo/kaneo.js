// Pure helpers for the Kaneo panel: config, response parsing, filters.
// No Herdr imports, so `node --test` can load this file.

const expand = (path, home) => (path.startsWith("~/") ? `${home}${path.slice(1)}` : path);
const trimSlash = (url) => url.replace(/\/+$/, "");

// `~/.config/herdr-app/kaneo.json`:
// { "url": "https://kaneo.example.com", "apiUrl"?: "<url>/api", "apiKey": "…",
//   "workspaces"?: ["slug or id", …], "repos"?: { "<PROJECT SLUG>": "~/dev/repo" },
//   "repoChoices"?: ["~/dev/other", …], "branchPattern"?: "{slug}-{number}-{title}",
//   "repoRoots"?: ["~/Projects", …] (where to look for repos), "cloneRoot"?: "~/Projects" (where to clone),
//   "demo"?: true (made-up tasks, no server) }
// `env` fills `url` and `apiKey` from KANEO_URL / KANEO_API_KEY when the file leaves them out.
export function parseConfig(text, home, env = {}) {
  const empty = { url: null, apiUrl: null, apiKey: null, workspaces: [], repos: {}, repoChoices: [], branchPattern: null, repoRoots: [], cloneRoot: null };
  let raw = {};
  if (text != null) {
    try { raw = JSON.parse(text) ?? {}; } catch { return { ...empty, error: "kaneo.json is not valid JSON" }; }
  }
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const url = str(raw.url) ?? str(env.url);
  const apiUrl = str(raw.apiUrl) ?? (url ? `${trimSlash(url)}/api` : null);
  const repos = {};
  for (const [project, folder] of Object.entries(raw.repos ?? {})) {
    if (str(folder)) repos[project.toUpperCase()] = expand(folder.trim(), home);
  }
  const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  return {
    url: url ? trimSlash(url) : null, apiUrl: apiUrl ? trimSlash(apiUrl) : null,
    apiKey: str(raw.apiKey) ?? str(env.apiKey),
    workspaces: list(raw.workspaces), repos,
    repoChoices: list(raw.repoChoices).map((f) => expand(f, home)),
    branchPattern: str(raw.branchPattern),
    demo: raw.demo === true, repoRoots: list(raw.repoRoots), cloneRoot: str(raw.cloneRoot) ? expand(str(raw.cloneRoot), home) : null,
  };
}

// The dialog's repositories: the default one first, then each choice on this computer, once each.
export function repoOptions(start, choices) {
  const options = start.cwd ? [start] : [];
  for (const cwd of choices) {
    if (!options.some((o) => o.cwd === cwd && !o.on)) options.push({ cwd, on: null });
  }
  return options;
}

// A short reason for a failed request, from its status and body ({ message, code }).
export function kaneoError(status, body) {
  if (status === 401) return "Invalid Kaneo API key";
  try {
    const message = JSON.parse(body)?.message;
    if (message) return `Kaneo: ${message}`;
  } catch { /* not JSON */ }
  return `Kaneo answered ${status}`;
}

// The workspaces to load: all of yours, or only those named (slug or id) in kaneo.json.
export function pickWorkspaces(all, wanted) {
  if (!wanted.length) return all;
  const keys = wanted.map((w) => w.toLowerCase());
  return all.filter((w) => keys.includes(String(w.slug).toLowerCase()) || keys.includes(String(w.id).toLowerCase()));
}

// Kaneo's label color names (its Tailwind shades); a hex color passes through.
const LABEL_COLORS = {
  gray: "#78716c", "dark-gray": "#64748b", purple: "#8b5cf6", teal: "#059669", green: "#16a34a",
  yellow: "#d97706", orange: "#ea580c", pink: "#e11d48", red: "#dc2626", blue: "#2563eb",
  sky: "#0ea5e9", cyan: "#0891b2", fuchsia: "#c026d3",
};
export const labelColor = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c : LABEL_COLORS[c] ?? null);

export const taskUrl = (base, workspaceId, t) =>
  `${base}/dashboard/workspace/${encodeURIComponent(workspaceId)}/project/${encodeURIComponent(t.projectId)}/task/${encodeURIComponent(t.id)}`;

// One task from a project board: `status`/`state` are its column's slug and name, `done` the column's isFinal.
function boardTask(t, project, column, workspace, base) {
  const slug = String(project.slug ?? "").toUpperCase();
  return {
    id: t.id, projectId: t.projectId ?? project.id, number: t.number,
    identifier: t.number != null ? `${slug}-${t.number}` : slug,
    title: t.title ?? "", url: taskUrl(base, workspace.id, { id: t.id, projectId: t.projectId ?? project.id }),
    priority: t.priority ?? "no-priority", dueDate: t.dueDate ?? null, createdAt: t.createdAt ?? null,
    status: column.slug, state: column.name, done: Boolean(column.isFinal), rank: column.rank,
    project: slug, projectName: project.name ?? slug, assignee: t.assigneeName ?? null,
    workspaceId: workspace.id, workspaceName: workspace.name,
    labels: (t.labels ?? []).map((l) => ({ name: l.name, color: labelColor(l.color) })),
    description: t.descriptionDeferred ? null : t.description ?? null, descriptionDeferred: Boolean(t.descriptionDeferred),
  };
}

// `GET /task/tasks/{projectId}` → every task on the board (each column, then planned); archived left out.
export function parseBoard(json, workspace, base) {
  const project = json?.data ?? {};
  const tasks = [];
  for (const column of project.columns ?? []) {
    const c = { slug: column.slug, name: column.name, isFinal: column.isFinal, rank: column.isFinal ? 3 : column.position ?? 0 };
    for (const t of column.tasks ?? []) tasks.push(boardTask(t, project, c, workspace, base));
  }
  const planned = { slug: "planned", name: "Planned", isFinal: false, rank: 2.5 };
  for (const t of project.plannedTasks ?? []) tasks.push(boardTask(t, project, planned, workspace, base));
  return tasks;
}

// Pages to ask for: board columns and the planned/archived lists page separately.
export const boardPages = (json) => Math.max(json?.pagination?.totalPages ?? 1, json?.pagination?.relatedTotalPages ?? 1);

const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1 };

// Open work first: in progress and review before to do, then planned, done last; then priority, newest.
export function sortIssues(issues) {
  const stage = (i) => (i.done ? 9 : i.status === "in-progress" ? 0 : i.status === "in-review" ? 1 : i.status === "to-do" ? 2
    : i.status === "planned" ? 4 : 3);
  return [...issues].sort((a, b) => stage(a) - stage(b) || (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
    || (b.number ?? 0) - (a.number ?? 0) || a.project.localeCompare(b.project));
}

// Kaneo's default columns first, then any custom ones by name, done ones last.
const STATUS_ORDER = ["in-progress", "in-review", "to-do", "planned"];
const rank = (s, done) => (done ? 99 : (() => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; })());

// Status chips: All, Open (anything not done), then each status the loaded tasks are in.
export function statusChips(issues) {
  const seen = new Map();
  for (const i of issues) if (!seen.has(i.status)) seen.set(i.status, { label: i.state || i.status, done: i.done });
  const chips = [...seen].sort(([a, x], [b, y]) => rank(a, x.done) - rank(b, y.done) || x.label.localeCompare(y.label))
    .map(([id, x]) => ({ id, label: x.label }));
  return [{ id: "all", label: "All" }, { id: "open", label: "Open" }, ...chips];
}

export function filterIssues(issues, { status, text }) {
  const needle = (text ?? "").trim().toLowerCase();
  return issues.filter((i) => (status === "all" || (status === "open" ? !i.done : i.status === status))
    && (!needle || `${i.identifier} ${i.title} ${i.projectName} ${i.state} ${i.assignee ?? ""}`.toLowerCase().includes(needle)));
}

export const PRIORITY_LABELS = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

// `due 3d`, `due 5h`, `due today`, `2d overdue`; `overdue` true when past.
export function due(iso, now = Date.now()) {
  if (!iso) return null;
  const hours = (Date.parse(iso) - now) / 3600000;
  if (Number.isNaN(hours)) return null;
  const span = (h) => (Math.abs(h) < 24 ? `${Math.max(1, Math.round(Math.abs(h)))}h` : `${Math.round(Math.abs(h) / 24)}d`);
  if (hours < 0) return { text: `${span(hours)} overdue`, overdue: true };
  if (hours < 1) return { text: "due now", overdue: false };
  return { text: `due ${span(hours)}`, overdue: false };
}

// Descriptions are Markdown; older ones may be HTML from the editor: drop tags and the common entities.
export function plainDescription(text) {
  if (!text) return null;
  if (!/^\s*</.test(text)) return String(text).trim() || null;
  return String(text).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim() || null;
}
