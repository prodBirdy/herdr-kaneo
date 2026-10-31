// Made-up tasks for `"demo": true` in kaneo.json: try the panel (and take screenshots) without a server.
import { sortIssues } from "./kaneo.js";

export const DEMO_PROJECTS = [
  { id: "demo-web", slug: "WEB", name: "Web app", workspace: "Acme" },
  { id: "demo-api", slug: "API", name: "API", workspace: "Acme" },
];

const COLUMNS = {
  "to-do": { state: "To Do", done: false }, "in-progress": { state: "In Progress", done: false },
  "in-review": { state: "In Review", done: false }, done: { state: "Done", done: true }, planned: { state: "Planned", done: false },
};

const TASKS = [
  ["WEB", 42, "Checkout button stays disabled after editing the cart", "in-progress", "urgent", ["#dc2626", "bug"], "Sam Lee", 1],
  ["API", 17, "Rate-limit the public search endpoint", "in-progress", "high", ["#2563eb", "backend"], "Ada Park", 3],
  ["WEB", 38, "Dark mode for the settings pages", "in-review", "medium", ["#8b5cf6", "design"], "Sam Lee", null],
  ["API", 21, "Return 404 instead of 500 for unknown workspace ids", "to-do", "high", ["#dc2626", "bug"], null, -2],
  ["WEB", 45, "Keyboard shortcuts for the task list", "to-do", "medium", ["#059669", "feature"], null, 6],
  ["API", 23, "Paginate the audit log export", "to-do", "low", ["#2563eb", "backend"], "Ada Park", null],
  ["WEB", 47, "Empty state for projects without tasks", "to-do", "low", ["#8b5cf6", "design"], null, null],
  ["API", 25, "Webhook retries with exponential backoff", "planned", "medium", ["#059669", "feature"], null, null],
  ["WEB", 31, "Upgrade the router to the new data APIs", "done", "medium", [], "Sam Lee", null],
  ["API", 12, "Move secrets out of the compose file", "done", "high", ["#d97706", "security"], "Ada Park", null],
];

export function demoIssues(now = Date.now()) {
  return sortIssues(TASKS.map(([project, number, title, status, priority, label, assignee, dueDays]) => ({
    id: `demo-${project}-${number}`, projectId: project === "WEB" ? "demo-web" : "demo-api", number,
    identifier: `${project}-${number}`, title, url: "", priority, createdAt: null,
    dueDate: dueDays == null ? null : new Date(now + dueDays * 86400000).toISOString(),
    status, state: COLUMNS[status].state, done: COLUMNS[status].done,
    project, projectName: project === "WEB" ? "Web app" : "API", assignee,
    workspaceId: "demo", workspaceName: "Acme",
    labels: label.length ? [{ name: label[1], color: label[0] }] : [],
    description: `A made-up task for the demo: ${title}.`, descriptionDeferred: false,
  })));
}
