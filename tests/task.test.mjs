import test from "node:test";
import assert from "node:assert/strict";
import { branchFor, worktreeFolder, branchProblem, checkoutOf, taskFor } from "../mods/kaneo/task.js";

const issue = { identifier: "WEB-7", project: "WEB", number: 7, title: "Fix the login bug on Safari now", url: "https://k/t", description: "Line one\nline two" };

test("branch names Kaneo's GitHub integration links back to the task", () => {
  assert.equal(branchFor(issue), "web-7-fix-the-login-bug-on");
  assert.equal(branchFor(issue, "{slug}-{number}"), "web-7-fix-the-login-bug-on");
  assert.equal(branchFor(issue, "feature/{slug}-{number}-{title}"), "feature/web-7-fix-the-login-bug-on");
  assert.equal(worktreeFolder("feature/web-7", "WEB-7"), "feature-web-7");
  assert.equal(worktreeFolder("..", "WEB-7"), "WEB-7");
  assert.ok(branchProblem("-x"));
  assert.equal(branchProblem("ok"), null);
});

test("checkoutOf finds where a branch is checked out", () => {
  const porcelain = "worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /w/web-7\nHEAD b\nbranch refs/heads/web-7\n";
  assert.equal(checkoutOf(porcelain, "web-7"), "/w/web-7");
  assert.equal(checkoutOf(porcelain, "nope"), null);
});

test("the task is one line, skill first, instructions after the summary", () => {
  const task = taskFor(issue, "web-7", { skill: "/review", instructions: "be\nbrief", subagents: true });
  assert.ok(!task.includes("\n"));
  assert.ok(task.startsWith("/review Work on Kaneo task WEB-7: Fix the login bug on Safari now (https://k/t)."));
  assert.ok(task.includes("Summary: Line one line two Instructions: be brief"));
  assert.ok(task.includes("subagents"));
  assert.ok(taskFor(issue, "web-7", { existing: true }).includes("existing checkout"));
});
