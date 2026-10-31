import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, parseBoard, boardPages, sortIssues, statusChips, filterIssues, due, plainDescription, labelColor, kaneoError, pickWorkspaces } from "../mods/kaneo/kaneo.js";
import { safeUrl } from "../mods/kaneo/urls.js";
import { demoIssues } from "../mods/kaneo/demo.js";

const board = {
  data: {
    id: "p1", slug: "web", name: "Web app",
    columns: [
      { id: "c1", slug: "to-do", name: "To Do", isFinal: false, position: 0, tasks: [
        { id: "t1", projectId: "p1", number: 3, title: "Docs", priority: "low", description: "## Hi", labels: [] }] },
      { id: "c2", slug: "in-progress", name: "In Progress", isFinal: false, position: 1, tasks: [
        { id: "t2", projectId: "p1", number: 7, title: "Fix login", priority: "urgent", assigneeName: "Sam",
          descriptionDeferred: true, description: null, labels: [{ name: "bug", color: "red" }] }] },
      { id: "c3", slug: "done", name: "Done", isFinal: true, position: 2, tasks: [
        { id: "t3", projectId: "p1", number: 1, title: "Setup", priority: "medium", labels: [] }] },
    ],
    plannedTasks: [{ id: "t4", projectId: "p1", number: 9, title: "Later", priority: "no-priority", labels: [] }],
    archivedTasks: [{ id: "t5", projectId: "p1", number: 2, title: "Old", status: "archived", labels: [] }],
  },
  pagination: { totalPages: 1, relatedTotalPages: 2 },
};

test("parseConfig reads the file, falls back to the environment, expands ~", () => {
  const c = parseConfig('{"url":"http://kaneo.lan/","apiKey":" k ","repos":{"web":"~/dev/web"},"repoRoots":["~/src"],"cloneRoot":"~/src"}', "/h");
  assert.equal(c.url, "http://kaneo.lan");
  assert.equal(c.apiUrl, "http://kaneo.lan/api");
  assert.equal(c.apiKey, "k");
  assert.deepEqual(c.repos, { WEB: "/h/dev/web" });
  assert.deepEqual(c.repoRoots, ["~/src"]);
  assert.equal(c.cloneRoot, "/h/src");
  assert.equal(parseConfig(null, "/h", { url: "https://x.y", apiKey: "e" }).apiKey, "e");
  assert.equal(parseConfig('{"demo":true}', "/h").demo, true);
  assert.ok(parseConfig("{", "/h").error);
});

test("parseBoard keeps every column and planned task, never archived ones", () => {
  const issues = parseBoard(board, { id: "w1", name: "Acme" }, "http://kaneo.lan");
  assert.deepEqual(issues.map((i) => i.identifier).sort(), ["WEB-1", "WEB-3", "WEB-7", "WEB-9"]);
  const fix = issues.find((i) => i.id === "t2");
  assert.equal(fix.url, "http://kaneo.lan/dashboard/workspace/w1/project/p1/task/t2");
  assert.equal(fix.state, "In Progress");
  assert.equal(fix.descriptionDeferred, true);
  assert.equal(fix.labels[0].color, "#dc2626");
  assert.equal(issues.find((i) => i.id === "t3").done, true);
  assert.equal(issues.find((i) => i.id === "t4").status, "planned");
  assert.equal(boardPages(board), 2);
});

test("sorting, chips and filters", () => {
  const issues = sortIssues(parseBoard(board, { id: "w1", name: "Acme" }, "http://kaneo.lan"));
  assert.equal(issues[0].identifier, "WEB-7");
  assert.equal(issues.at(-1).identifier, "WEB-1");
  assert.deepEqual(statusChips(issues).map((c) => c.label), ["All", "Open", "In Progress", "To Do", "Planned", "Done"]);
  assert.equal(filterIssues(issues, { status: "open", text: "" }).length, 3);
  assert.equal(filterIssues(issues, { status: "all", text: "sam" }).length, 1);
  assert.equal(filterIssues(issues, { status: "done", text: "" })[0].identifier, "WEB-1");
});

test("helpers", () => {
  const now = Date.parse("2026-10-31T00:00:00Z");
  assert.deepEqual(due("2026-10-29T00:00:00Z", now), { text: "2d overdue", overdue: true });
  assert.equal(due("2026-11-03T00:00:00Z", now).text, "due 3d");
  assert.equal(due(null), null);
  assert.equal(plainDescription("<p>Hi &amp; bye</p>"), "Hi & bye");
  assert.equal(plainDescription("## Problem\n`<x>`"), "## Problem\n`<x>`");
  assert.equal(labelColor("#abcdef"), "#abcdef");
  assert.equal(labelColor("nope"), null);
  assert.equal(kaneoError(401, ""), "Invalid Kaneo API key");
  assert.equal(kaneoError(400, '{"message":"bad"}'), "Kaneo: bad");
  assert.deepEqual(pickWorkspaces([{ id: "a", slug: "one" }, { id: "b", slug: "two" }], ["TWO"]).map((w) => w.id), ["b"]);
  assert.ok(demoIssues().length > 5);
});

test("only links on the configured instance open", () => {
  assert.ok(safeUrl("http://kaneo.lan/dashboard/x", "http://kaneo.lan"));
  assert.equal(safeUrl("https://evil.example/x", "http://kaneo.lan"), null);
  assert.equal(safeUrl("file:///etc/passwd", "http://kaneo.lan"), null);
});
