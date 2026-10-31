// Every Kaneo task (self-hosted). Select tasks and Start: each gets a worktree and an agent right away,
// with the agent, model and options last chosen in the `kaneo-agent` dialog (`⋯` on a row).
// Each project works in a repo found on this computer (Kaneo's git link, else its name) or picked in Repos.
// Docked in a side panel of a cloned layout, or a popup (`mod.open:kaneo`).
// Ported from the Linear mod in dantech99/herdr-linear (MIT).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, notify, shared, setShared, theme, home, appHome, readTextFile, nextCommand, openOverlay } from "herdr";
import { parseConfig, kaneoError, pickWorkspaces, parseBoard, boardPages, sortIssues, statusChips, filterIssues, PRIORITY_LABELS, due, plainDescription, repoOptions } from "./kaneo.js";
import { SCAN_SCRIPT, scanRoots, parseScan, linkFrom, resolveRepo, remoteKey, cloneProblem } from "./repos.js";
import { branchFor } from "./task.js";
import { LAST_CHOICE, defaultChoice, prepare } from "./start.js";
import { openUrl } from "./open.js";
import { DEMO_PROJECTS, demoIssues } from "./demo.js";

const REFRESH_MS = 60000;
const MAX_PAGES = 20;
const DESCRIPTION_PAGES = 5;
const PICKED = "kaneo.repos";
const LINKS = "kaneo.links";
const LINKS_MS = 60 * 60 * 1000;
const PROVIDERS = ["github", "gitlab", "gitea"];
const NO_URL = "No Kaneo URL. Add \"url\" to ~/.config/herdr-app/kaneo.json or set KANEO_URL.";
const NO_KEY = "No Kaneo API key. Add \"apiKey\" to ~/.config/herdr-app/kaneo.json or set KANEO_API_KEY.";

// KANEO_URL and KANEO_API_KEY from the shell agents start in, when kaneo.json has none.
async function envVars() {
  const r = await exec("sh", ["-c", 'printf "%s\\n%s" "$KANEO_URL" "$KANEO_API_KEY"']).catch(() => null);
  if (r?.code !== 0) return {};
  const [url, apiKey] = r.stdout.split("\n");
  return { url, apiKey };
}

async function loadConfig() {
  const text = await readTextFile(`${appHome()}/kaneo.json`).catch(() => null);
  let config = parseConfig(text, home());
  if (!config.error && (!config.url || !config.apiKey)) config = parseConfig(text, home(), await envVars());
  return config;
}

// The key goes only to the configured instance's API.
async function api(config, path) {
  let r;
  try {
    r = await fetch(`${config.apiUrl}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${config.apiKey}` },
    });
  } catch (e) { throw new Error(`Could not reach ${config.apiUrl}: ${e.message ?? e}`); }
  const body = await r.text();
  if (r.status === 429) {
    // Kaneo allows each API key 100 requests a minute: wait for the reset it names.
    const after = Number(r.headers?.get?.("retry-after")), reset = Number(r.headers?.get?.("x-ratelimit-reset"));
    const e = new Error("Kaneo rate limit reached");
    e.retryAt = after > 0 ? Date.now() + after * 1000 : reset > 0 ? reset * 1000 : Date.now() + 60000;
    throw e;
  }
  if (!r.ok) throw new Error(kaneoError(r.status, body));
  try { return JSON.parse(body); } catch { throw new Error(`Not a Kaneo API at ${config.apiUrl} (set "apiUrl")`); }
}

// One project's whole board, every page; a task seen on an earlier page is kept once.
async function projectTasks(config, workspace, project) {
  const byId = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await api(config, `/task/tasks/${encodeURIComponent(project.id)}?limit=100&page=${page}&relatedPage=${page}`);
    for (const t of parseBoard(json, workspace, config.url)) if (!byId.has(t.id)) byId.set(t.id, t);
    if (page >= boardPages(json)) break;
  }
  return [...byId.values()];
}

// Every task in every project of the chosen workspaces (archived projects and tasks left out).
async function fetchIssues(config) {
  const workspaces = pickWorkspaces(await api(config, "/workspace"), config.workspaces);
  const projects = [];
  const lists = await Promise.all(workspaces.map(async (w) => {
    const list = await api(config, `/project?workspaceId=${encodeURIComponent(w.id)}`);
    for (const p of list) projects.push({ id: p.id, slug: String(p.slug ?? "").toUpperCase(), name: p.name ?? p.slug, workspace: w.name });
    return Promise.all(list.map((p) => projectTasks(config, w, p)));
  }));
  projects.sort((a, b) => a.slug.localeCompare(b.slug));
  return { issues: sortIssues(lists.flat(2)), projects, workspaces: workspaces.length };
}

// Each project's git link in Kaneo (GitHub, GitLab or Gitea), or none.
async function fetchLinks(config, projects) {
  const links = {};
  await Promise.all(projects.map(async (p) => {
    for (const provider of PROVIDERS) {
      const json = await api(config, `/${provider}-integration/project/${encodeURIComponent(p.id)}`)
        .catch((e) => { if (e.retryAt) throw e; return null; });
      const link = linkFrom(provider, json);
      if (link) { links[p.id] = link; return; }
    }
  }));
  return links;
}

// Git checkouts on this computer, under the repo roots.
async function scanRepos(config) {
  const r = await exec("sh", ["-c", SCAN_SCRIPT, "sh", ...scanRoots(config, home())]).catch(() => null);
  return parseScan(r?.stdout ?? "");
}

// The full description when the board left it out.
async function fullDescription(config, issue) {
  if (!issue.descriptionDeferred) return plainDescription(issue.description);
  let text = "", offset = 0;
  for (let page = 0; page < DESCRIPTION_PAGES && offset != null; page++) {
    const p = await api(config, `/task/${encodeURIComponent(issue.id)}/description?offset=${offset}`);
    text += p?.content ?? ""; offset = p?.nextOffset ?? null;
  }
  return plainDescription(text);
}

const PRIORITY_COLORS = { urgent: "ansi1", high: "working" };
const STATUS_COLORS = { "to-do": "dim", "in-progress": "working", "in-review": "accent", planned: "muted" };
const RUNNING = ["starting", "ready", "started"];

export default class Kaneo extends View {
  init(_props, cx) {
    this.issues = []; this.projects = []; this.links = {}; this.scan = null;
    this.status = "open"; this.text = ""; this.generation = 0; this.loading = false;
    this.selected = new Set(); this.runs = {}; this.starting = false; this.opening = null;
    this.view = "tasks"; this.pick = null; this.repoText = ""; this.cloneError = null;
    this.search = InputState.new({ placeholder: "Filter" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value(); cx.notify(); });
    this.repoFilter = InputState.new({ placeholder: "Filter repos" });
    this.repoFilter.on("change", (_e, cx) => { this.repoText = this.repoFilter.value(); cx.notify(); });
    this.cloneInput = InputState.new({ placeholder: "git@github.com:owner/repo.git" });
    this.cloneInput.on("submit", (_e, cx) => this.pickClone(this.pick, cx));
    this.refresh(cx, true);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx, true);
        if (command === "repos") { this.view = this.view === "repos" ? "tasks" : "repos"; this.pick = null; }
        cx.notify();
      }
    });
  }

  // Tasks every minute; the repo scan and Kaneo's git links on open and on Refresh (links cached
  // for an hour, so reloads don't spend the API key's 100 requests a minute). After a rate limit,
  // nothing is asked until its reset.
  refresh(cx, repos = false, force = false) {
    if (!force && this.pausedUntil && Date.now() < this.pausedUntil) return;
    const generation = ++this.generation;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const config = await loadConfig();
        this.config = config;
        if (config.error) throw new Error(config.error);
        if (config.demo) {
          this.issues = demoIssues(); this.projects = DEMO_PROJECTS; this.error = null; this.loading = false;
          cx.notify();
          if (repos) this.scan = await scanRepos(config);
          return;
        }
        if (!config.url) throw new Error(NO_URL);
        if (!config.apiKey) throw new Error(NO_KEY);
        if (repos) this.repoLoad = scanRepos(config);
        const { issues, projects, workspaces } = await fetchIssues(config);
        if (generation === this.generation) {
          this.issues = issues; this.projects = projects; this.error = workspaces ? null : "No matching Kaneo workspace";
          const ids = new Set(issues.map((i) => i.id));
          for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
        }
        this.pausedUntil = null; this.notice = null;
        if (repos) {
          const cached = shared(LINKS);
          const fresh = !force && cached && Date.now() - cached.at < LINKS_MS && projects.every((p) => p.id in (cached.checked ?? {}));
          const links = fresh ? cached.links : await fetchLinks(config, projects);
          if (!fresh) setShared(LINKS, { at: Date.now(), links, checked: Object.fromEntries(projects.map((p) => [p.id, true])) });
          this.scan = await this.repoLoad; this.links = links;
        }
      } catch (e) {
        if (generation !== this.generation) return;
        if (e.retryAt) {
          this.pausedUntil = e.retryAt;
          const at = new Date(e.retryAt).toTimeString().slice(0, 5);
          this.notice = `Kaneo rate limit reached; trying again after ${at}`;
          if (!this.issues.length) this.error = this.notice;
          this.links = shared(LINKS)?.links ?? this.links;
          this.scan = await this.repoLoad?.catch(() => null) ?? this.scan;
        } else this.error = String(e.message ?? e);
      }
      finally { if (generation === this.generation) this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  cloneRoot() {
    return this.config?.cloneRoot ?? this.scan?.roots?.[0] ?? `${home()}/Projects`;
  }

  // Where a project's agents work, on this computer: { cwd, on, clone, source } or null (ask).
  repoOf(projectId) {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return null;
    const r = resolveRepo(project, {
      saved: (shared(PICKED) ?? {})[projectId], mapped: this.config?.repos?.[project.slug],
      link: this.links[projectId], repos: this.scan?.repos ?? [], cloneRoot: this.cloneRoot(),
    });
    return r ? { ...r, on: null } : null;
  }

  savePick(projectId, value) {
    const picked = { ...(shared(PICKED) ?? {}) };
    if (value) picked[projectId] = value; else delete picked[projectId];
    setShared(PICKED, picked);
  }

  pickClone(projectId, cx) {
    const url = this.cloneInput.value().trim();
    this.cloneError = cloneProblem(url);
    if (!this.cloneError && projectId) {
      this.savePick(projectId, { cwd: `${this.cloneRoot()}/${remoteKey(url).split("/").pop()}`, clone: url });
      this.cloneInput.set_value(""); this.pick = null;
    }
    cx.notify();
  }

  showRepos(projectId, cx) {
    this.view = "repos"; this.pick = projectId; this.cloneError = null;
    this.repoFilter.set_value(""); this.repoText = "";
    cx.notify();
  }

  // Start, no questions: a worktree and an agent for each task, with the dialog's last choice.
  // A project without a repo opens Repos to pick one. Every worktree is made first and the spaces
  // opened together at the end, so a popup closing when the first space shows can't stop the rest.
  startAgents(issues, cx) {
    if (this.starting || !issues.length) return;
    const config = this.config;
    this.starting = true;
    for (const i of issues) this.runs[i.id] = "starting";
    cx.spawn(async (cx) => {
      if (!this.scan) { this.scan = await this.repoLoad?.catch(() => null) ?? this.scan; }
      const ready = [], failed = [], missing = [], choices = {};
      for (const issue of issues) {
        const repo = this.repoOf(issue.projectId);
        if (!repo) { delete this.runs[issue.id]; if (!missing.includes(issue.projectId)) missing.push(issue.projectId); continue; }
        try {
          choices[""] ??= await defaultChoice(null);
          const description = config.demo ? issue.description : await fullDescription(config, issue).catch(() => null);
          const branch = branchFor(issue, config?.branchPattern ?? this.links[issue.projectId]?.branchPattern);
          ready.push(await prepare({ ...issue, description }, { ...repo, branch, choice: choices[""] }));
          this.runs[issue.id] = "ready";
        } catch (e) {
          this.runs[issue.id] = String(e.message ?? e);
          failed.push(`${issue.identifier}: ${this.runs[issue.id]}`);
        }
        cx.notify();
      }
      this.starting = false;
      for (const i of issues) if (this.runs[i.id] === "ready") { this.runs[i.id] = "started"; this.selected.delete(i.id); }
      if (failed.length) {
        notify({ title: `Could not start ${failed.length} agent${failed.length > 1 ? "s" : ""}`, body: failed.join("\n"), level: "error" });
      }
      if (missing.length) {
        const slugs = missing.map((id) => this.projects.find((p) => p.id === id)?.slug).join(", ");
        notify({ title: "Pick a repo first", body: `No repo found for ${slugs}. Pick one in Repos, then Start again.`, level: "warning" });
        this.showRepos(missing[0], cx);
      }
      cx.notify();
      for (const args of ready) run("space.new", args);
    });
    cx.notify();
  }

  // The dialog, to pick the agent, model, branch and instructions for one task.
  openDialog(issue, cx) {
    if (this.opening) return;
    const config = this.config, start = this.repoOf(issue.projectId);
    if (!start) return this.showRepos(issue.projectId, cx);
    this.opening = issue.id;
    cx.spawn(async (cx) => {
      const description = await fullDescription(config, issue).catch(() => null);
      this.opening = null;
      openOverlay({ mod: "kaneo-agent", kind: "dialog", width: 480, height: 660,
        props: { issue: { ...issue, description },
          branchPattern: config?.branchPattern ?? this.links[issue.projectId]?.branchPattern ?? null,
          ...start, repos: repoOptions(start, config?.repoChoices ?? []) } });
      cx.notify();
    });
    cx.notify();
  }

  toggle(issue) {
    if (this.selected.has(issue.id)) this.selected.delete(issue.id); else this.selected.add(issue.id);
  }

  button(id, label, onClick, t, active = false) {
    return div().id(id).flex_none().px(8).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(11)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  chip(status, t) {
    const active = this.status === status.id;
    return h_flex().id(`status-${status.id}`).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(11)
      .bg(active ? t.selected : t.raised).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.status = status.id; cx.notify(); }).child(status.label);
  }

  checkbox(on, t) {
    return div().flex_none().size(14).rounded(4).border_1().flex().items_center().justify_center().text_size(10)
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).text_color(t.accent_foreground)
      .child(on ? "✓" : "");
  }

  // A small row button that doesn't toggle the row.
  rowButton(id, label, onClick, t, strong = false) {
    return div().id(id).flex_none().px(7).h(20).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .text_color(strong ? t.foreground : t.muted).border_1().border_color(t.border).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }).child(label);
  }

  runLabel(issue) {
    const r = this.runs[issue.id];
    if (r === "starting" || r === "ready") return "…";
    if (r === "started") return "✓";
    return "▶ Start";
  }

  meta(issue, t) {
    const priority = PRIORITY_LABELS[issue.priority] ?? null;
    return h_flex().flex_1().min_w(0).gap(8).items_center().overflow_hidden()
      .child(h_flex().flex_none().gap(5).items_center()
        .child(div().size(7).rounded_full().bg(issue.done ? t.done : t[STATUS_COLORS[issue.status]] ?? t.idle))
        .child(div().text_color(t.muted).child(issue.state)))
      .when(Boolean(priority), (e) => e.child(div().flex_none().text_color(t[PRIORITY_COLORS[issue.priority]] ?? t.dim).child(priority)))
      .children(issue.labels.slice(0, 2).map((l) => div().flex_none().px(5).rounded(4).border_1()
        .border_color(l.color ? `${l.color}88` : t.border).text_color(t.muted).child(l.name)));
  }

  row(issue, t) {
    const d = due(issue.dueDate), on = this.selected.has(issue.id), r = this.runs[issue.id];
    const failed = r && !RUNNING.includes(r);
    return v_flex().id(`issue-${issue.id}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => { this.toggle(issue); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(this.checkbox(on, t))
        .child(div().id(`open-${issue.id}`).flex_none().text_size(11).text_color(t.accent).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); openUrl(issue.url, this.config?.url); }).child(issue.identifier))
        .child(div().flex_1().min_w(0).truncate().text_color(issue.done ? t.muted : t.foreground).child(issue.title))
        .child(this.rowButton(`start-${issue.id}`, this.runLabel(issue), (_e, cx) => this.startAgents([issue], cx), t, true))
        .child(this.rowButton(`dialog-${issue.id}`, this.opening === issue.id ? "…" : "⋯", (_e, cx) => this.openDialog(issue, cx), t)))
      .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim).pl(22)
        .child(this.meta(issue, t))
        .child(h_flex().flex_none().gap(4)
          .child(div().child(issue.assignee ?? "Unassigned"))
          .when(Boolean(d), (e) => e.child("·").child(div().text_color(d.overdue && !issue.done ? t.ansi1 : t.dim).child(d?.text ?? "")))))
      .when(Boolean(failed), (e) => e.child(div().pl(22).text_size(11).text_color(t.ansi1).truncate().child(r ?? "")));
  }

  // What Start runs with: the dialog's last choice, else Claude Code (or the first installed agent).
  choiceText() {
    const last = shared(LAST_CHOICE);
    if (!last?.agent) return "Claude Code, its defaults · ⋯ on a task to change";
    return [last.agent, last.model, last.effort, last.skill, last.subagents ? "subagents" : null].filter(Boolean).join(" · ");
  }

  selectionBar(list, t) {
    const chosen = this.issues.filter((i) => this.selected.has(i.id));
    const allShown = list.length > 0 && list.every((i) => this.selected.has(i.id));
    return v_flex().flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border).bg(t.chrome).text_size(11)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(`${chosen.length} selected`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.choiceText())))
      .child(h_flex().gap(4).items_center()
        .child(this.button("select-shown", allShown ? "Unselect shown" : "Select shown", (_e, cx) => {
          for (const i of list) if (allShown) this.selected.delete(i.id); else this.selected.add(i.id);
          cx.notify();
        }, t))
        .child(this.button("clear", "Clear", (_e, cx) => { this.selected.clear(); cx.notify(); }, t))
        .child(div().flex_1())
        .child(div().id("start-selected").flex_none().px(12).h(28).flex().items_center().rounded(8).cursor_pointer()
          .bg(this.starting ? t.raised : t.solid).text_color(this.starting ? t.dim : t.solid_foreground)
          .on_click((_e, cx) => this.startAgents(chosen, cx))
          .child(this.starting ? "Starting…" : `▶ Start ${chosen.length} agent${chosen.length > 1 ? "s" : ""}`)));
  }

  short(path) {
    const h = home();
    return path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "";
  }

  // The repos on this computer to pick from, filtered; the clone field under them.
  repoChooser(project, t) {
    const f = this.repoText.trim().toLowerCase();
    const repos = (this.scan?.repos ?? []).filter((r) => !f || `${r.name} ${r.remote ?? ""} ${r.path}`.toLowerCase().includes(f));
    const field = (state, extra = (e) => e) => extra(div().h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(state).h_full().text_size(11).text_color(t.foreground)));
    return v_flex().gap(6).pl(10)
      .child(field(this.repoFilter))
      .child(v_flex().id(`repos-${project.id}`).max_h(220).overflow_y_scrollbar().gap(1)
        .children(repos.map((r) => h_flex().id(`repo-${project.id}-${r.path}`).flex_none().h(26).px(6).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.savePick(project.id, { cwd: r.path }); this.pick = null; cx.notify(); })
          .child(div().flex_none().text_color(t.foreground).child(r.name))
          .when(!r.main, (e) => e.child(div().flex_none().text_color(t.dim).child("worktree")))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.remote ?? this.short(r.path)))))
        .when(!repos.length, (e) => e.child(div().px(6).py(4).text_color(t.dim)
          .child(this.scan ? "No git repos found here" : "Scanning…"))))
      .child(div().text_color(t.dim).child(`Or clone one into ${this.short(this.cloneRoot())} on first Start:`))
      .child(h_flex().gap(6).items_center()
        .child(field(this.cloneInput, (e) => e.flex_1().min_w(0)))
        .child(this.button(`clone-${project.id}`, "Use", (_e, cx) => this.pickClone(project.id, cx), t, true)))
      .when(Boolean(this.cloneError), (e) => e.child(div().text_color(t.ansi1).child(this.cloneError ?? "")));
  }

  projectRepo(project, picked, t) {
    const r = this.repoOf(project.id), open = this.pick === project.id;
    return v_flex().flex_none().gap(4).p(8).rounded(8).border_1().border_color(open ? t.accent : t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_color(t.accent).child(project.slug))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(project.name))
        .when(Boolean(picked[project.id]), (e) => e.child(this.button(`auto-${project.id}`, "Automatic",
          (_e, cx) => { this.savePick(project.id, null); cx.notify(); }, t)))
        .child(this.button(`change-${project.id}`, open ? "Done" : "Change",
          (_e, cx) => (open ? (this.pick = null, cx.notify()) : this.showRepos(project.id, cx)), t, open)))
      .child(r
        ? h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.short(r.cwd)))
          .child(div().flex_none().text_color(t.dim).child(r.source))
        : div().text_color(t.ansi1).child(this.scan ? "No repo found: pick one" : "Looking for repos…"))
      .when(open, (e) => e.child(this.repoChooser(project, t)));
  }

  reposView(t) {
    const picked = shared(PICKED) ?? {};
    return v_flex().id("kaneo-repos").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8).text_size(11)
      .child(div().text_color(t.dim).child("Where each project's agents work. Picked here, else kaneo.json, else the project's GitHub/GitLab/Gitea link in Kaneo (cloned if missing), else a repo named like the project."))
      .children(this.projects.map((p) => this.projectRepo(p, picked, t)))
      .when(!this.projects.length, (e) => e.child(div().text_color(t.dim).child(this.loading ? "Loading…" : "No projects")));
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Loading…";
    return this.issues.length ? "No tasks match these filters" : "No tasks yet";
  }

  render() {
    const t = theme(), chips = statusChips(this.issues), repos = this.view === "repos";
    if (!chips.some((c) => c.id === this.status)) this.status = "all";
    const list = filterIssues(this.issues, { status: this.status, text: this.text });
    const open = this.issues.filter((i) => !i.done).length;
    return v_flex().id("kaneo").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Kaneo"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${open} open · ${this.issues.length} tasks`))
        .child(this.button("repos", "Repos", (_e, cx) => { this.view = repos ? "tasks" : "repos"; this.pick = null; cx.notify(); }, t, repos))
        .child(this.button("refresh", this.loading ? "…" : "Refresh", (_e, cx) => this.refresh(cx, true, true), t)))
      .when(Boolean(this.notice) && this.issues.length > 0, (e) => e.child(div().flex_none().px(14).py(5).text_size(11)
        .text_color(t.working).border_b(1).border_color(t.border).child(this.notice ?? "")))
      .when(repos, (e) => e.child(this.reposView(t)))
      .when(!repos, (e) => e
        .child(h_flex().flex_none().flex_wrap().px(8).py(7).gap(6).items_center().border_b(1).border_color(t.border)
          .children(chips.map((s) => this.chip(s, t)))
          .child(div().w(130).flex_none().h(24).px(8).flex().items_center().rounded(6).border_1()
            .border_color(this.text.trim() ? t.accent : t.border).bg(t.background)
            .child(Input.new(this.search).h_full().text_size(11).text_color(t.foreground))))
        .child(v_flex().id("kaneo-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
          .children(list.map((issue) => this.row(issue, t)))
          .when(!list.length, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(this.emptyText()))))
        .when(this.selected.size > 0, (e) => e.child(this.selectionBar(list, t))));
  }
}
