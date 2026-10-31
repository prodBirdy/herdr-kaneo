// Start an agent on a Kaneo task: props { issue, branchPattern, cwd, on, repos }.
// Makes a worktree from the default branch and a space running the agent with the task as its task.
// Ported from `linear-agent` in dantech99/herdr-linear (MIT), itself adapted from the `issue-agent`
// mod in obrunogonzaga/herdr-mods (MIT, Copyright (c) 2026 Bruno Gonzaga).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, knownAgents, shared, setShared } from "herdr";
import { adapterFor } from "./agents.js";
import { branchFor } from "./task.js";
import { LAST_CHOICE, prepare } from "./start.js";

const MODEL_CACHE = "kaneo-agent.models";
const CACHE_MS = 60 * 60 * 1000;

async function modelsFor(agent, on) {
  const cache = shared(MODEL_CACHE) ?? {};
  const key = `${on ?? ""}:${agent.key}`;
  if (cache[key] && Date.now() - cache[key].at < CACHE_MS) return cache[key].models;
  const models = await adapterFor(agent).models(on);
  setShared(MODEL_CACHE, { ...cache, [key]: { at: Date.now(), models } });
  return models;
}

export default class KaneoAgent extends View {
  init(_props, cx) {
    this.issue = props()?.issue ?? { identifier: "", title: "Open this from a task in the Kaneo panel", url: "" };
    this.agents = []; this.models = []; this.filter = "";
    const last = shared(LAST_CHOICE) ?? {};
    this.subagents = Boolean(last.subagents);
    this.repos = props()?.repos ?? [];
    this.repo = this.repos[0] ?? { cwd: props()?.cwd, on: props()?.on };
    this.branchInput = InputState.new({ value: this.issue.identifier ? branchFor(this.issue, props()?.branchPattern) : "", placeholder: "branch name" });
    this.filterInput = InputState.new({ placeholder: "filter or type a model" });
    this.skillInput = InputState.new({ value: last.skill ?? "", placeholder: "/skill-name (optional)" });
    this.instructionsInput = TextareaState.new({ placeholder: "Anything the agent should know or do (optional)" });
    this.instructionsInput.set_auto_grow(3, 8);
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value().trim(); cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => this.start(cx));
    this.loadAgents(cx);
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => {
      try {
        this.agents = (await knownAgents({ on: props()?.on })).filter((a) => a.installed);
        const last = shared(LAST_CHOICE) ?? {};
        this.pickAgent(this.agents.find((a) => a.key === last.agent) ?? this.agents[0], cx, last);
      } catch (e) { this.error = `Could not list agents: ${e}`; }
      cx.notify();
    });
  }

  pickAgent(agent, cx, last = {}) {
    if (!agent) { this.error = "No agent installed on this machine"; return; }
    this.agent = agent; this.models = []; this.model = null; this.effort = null; this.modelsError = null;
    this.filterInput.set_value(""); this.filter = "";
    if (!adapterFor(agent)) return cx.notify();
    this.loadingModels = true;
    cx.spawn(async (cx) => {
      try {
        const models = await modelsFor(agent, props()?.on);
        if (this.agent !== agent) return;
        this.models = models;
        const remembered = last.agent === agent.key ? models.find((m) => m.id === last.model) : null;
        this.pickModel(remembered ?? null, remembered ? last.effort : null);
      } catch (e) { if (this.agent === agent) this.modelsError = String(e.message ?? e); }
      finally { if (this.agent === agent) this.loadingModels = false; cx.notify(); }
    });
    cx.notify();
  }

  pickModel(model, effort = null) {
    this.model = model;
    const efforts = model?.efforts ?? [];
    this.effort = efforts.includes(effort) ? effort : efforts.includes(model?.effort) ? model.effort : null;
  }

  // The typed model when it matches none, so models a CLI can't list still work.
  chosenModelId() {
    if (this.model) return this.model.id;
    return this.filter && !this.models.some((m) => m.id === this.filter) ? this.filter : null;
  }

  start(cx) {
    const branch = this.branchInput.value().trim();
    if (this.busy || !this.agent || !branch || !this.issue.identifier) return;
    const { cwd, on, clone } = this.repo, agent = this.agent, model = this.chosenModelId(), effort = this.effort;
    const subagents = this.subagents, issue = this.issue;
    const skill = this.skillInput.value().trim(), instructions = this.instructionsInput.value();
    this.busy = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const args = await prepare(issue, { cwd, on, clone, branch, instructions, choice: { agent, model, effort, subagents, skill } });
        setShared(LAST_CHOICE, { agent: agent.key, model, effort, subagents, skill });
        run("space.new", args);
        closeOverlay(props().overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  section(title, child, t) {
    return v_flex().gap(6).child(div().text_size(11).text_color(t.dim).child(title)).child(child);
  }

  chip(id, label, selected, onClick, t, icon = null) {
    return h_flex().id(id).h(26).px(9).gap(6).items_center().rounded(7).cursor_pointer().flex_none()
      .bg(selected ? t.selected : t.raised).text_color(selected ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .when(Boolean(icon), (e) => e.child(icon)).child(label);
  }

  field(state, t) {
    return div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  agentIcon(a, t) {
    if (!a.icon) return null;
    return a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14);
  }

  agentRow(t) {
    if (!this.agents.length) return div().text_color(t.dim).child(this.error ?? "Checking installed agents…");
    return h_flex().flex_wrap().gap(6).children(this.agents.map((a) =>
      this.chip(`agent-${a.key}`, a.name, this.agent === a, (cx) => this.pickAgent(a, cx), t, this.agentIcon(a, t))));
  }

  modelList(t) {
    const f = this.filter.toLowerCase();
    const shown = this.models.filter((m) => !f || `${m.id} ${m.label ?? ""}`.toLowerCase().includes(f)).slice(0, 100);
    const custom = this.chosenModelId() && !this.model ? this.chosenModelId() : null;
    const row = (id, label, selected, onClick) => h_flex().id(`model-${id}`).h(26).px(8).gap(8).items_center().rounded(6).flex_none().cursor_pointer()
      .when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_color(selected ? t.foreground : t.muted).child(label));
    return v_flex().gap(6).child(this.field(this.filterInput, t))
      .child(v_flex().id("models").h(150).overflow_y_scrollbar().gap(1)
        .child(row("default", custom ? `Use "${custom}"` : "Agent's default", !this.model, () => this.pickModel(null)))
        .children(shown.map((m) => row(m.id, m.label && m.label !== m.id ? `${m.label}  ·  ${m.id}` : m.id, this.model === m, () => this.pickModel(m, this.effort))))
        .when(this.loadingModels, (e) => e.child(div().px(8).py(4).text_color(t.dim).child("Loading models…")))
        .when(Boolean(this.modelsError), (e) => e.child(div().px(8).py(4).text_color(t.ansi1).child(this.modelsError))));
  }

  effortRow(t) {
    const efforts = this.model?.efforts ?? [];
    if (!efforts.length) return div().text_color(t.dim).child(this.model ? "This model has no reasoning levels" : "Agent's default");
    return h_flex().flex_wrap().gap(6).children(efforts.map((e) =>
      this.chip(`effort-${e}`, e, this.effort === e, () => { this.effort = this.effort === e ? null : e; }, t)));
  }

  footer(t) {
    const ready = Boolean(this.agent) && !this.busy;
    return h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi1).child(this.error ?? ""))
      .child(h_flex().id("cancel").h(30).px(12).items_center().rounded(8).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("Cancel"))
      .child(h_flex().id("start").h(30).px(14).items_center().rounded(8).cursor_pointer()
        .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
        .on_click((_e, cx) => this.start(cx)).child(this.busy ? "Starting…" : "Start agent"));
  }

  // One chip per repository when there's a choice, named after its folder; else the folder itself.
  repoRow(t) {
    const { cwd, on, clone } = this.repo;
    const label = div().text_color(cwd ? t.muted : t.ansi1).truncate()
      .child(cwd ? `${cwd}${on ? `  ·  ${on}` : ""}${clone ? "  ·  cloned on Start" : ""}` : "No folder: pick a repo in the panel's Repos");
    if (this.repos.length < 2) return label;
    return v_flex().gap(6).child(h_flex().flex_wrap().gap(6).children(this.repos.map((r, i) =>
      this.chip(`repo-${i}`, `${r.cwd.split("/").pop()}${r.on ? ` · ${r.on}` : ""}`, this.repo === r, () => { this.repo = r; }, t))))
      .child(label);
  }

  render() {
    const t = theme(), hasModels = this.agent && adapterFor(this.agent);
    // The sections scroll and the footer stays, so Start is always reachable in a short window.
    return v_flex().id("kaneo-agent").size_full().p(16).gap(14).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(v_flex().flex_none().gap(2)
        .child(div().text_size(14).font_semibold().child(`Start an agent on ${this.issue.identifier}`))
        .child(div().text_color(t.dim).truncate().child(this.issue.title)))
      .child(v_flex().id("kaneo-agent-body").flex_1().min_h(0).overflow_y_scrollbar().gap(14)
        .child(this.section("Repository", this.repoRow(t), t))
        .child(this.section("Branch", this.field(this.branchInput, t), t))
        .child(this.section("Instructions", div().px(10).py(6).rounded(8).border_1().border_color(t.border).bg(t.background)
          .child(Textarea.new(this.instructionsInput).w_full().text_size(12).text_color(t.foreground)), t))
        .child(this.section("Skill: starts the agent's first message", this.field(this.skillInput, t), t))
        .child(this.section("Agent", this.agentRow(t), t))
        .when(Boolean(hasModels), (e) => e.child(this.section("Model", this.modelList(t), t)).child(this.section("Reasoning", this.effortRow(t), t)))
        .child(this.section("Options", h_flex().child(this.chip("subagents", this.subagents ? "✓ Ask it to use subagents" : "Ask it to use subagents",
          this.subagents, () => { this.subagents = !this.subagents; }, t)), t)))
      .child(div().flex_none().child(this.footer(t)));
  }
}
