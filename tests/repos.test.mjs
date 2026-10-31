import test from "node:test";
import assert from "node:assert/strict";
import { remoteKey, parseScan, linkFrom, resolveRepo, cloneProblem, scanRoots } from "../mods/kaneo/repos.js";

test("remoteKey compares remotes and drops credentials", () => {
  assert.equal(remoteKey("git@github.com:Acme/Web.git"), "github.com/acme/web");
  assert.equal(remoteKey("https://x-access-token:secret@github.com/acme/web.git"), "github.com/acme/web");
  assert.equal(remoteKey("ssh://git@gitea.lan:2222/acme/web"), "gitea.lan/acme/web");
  assert.equal(remoteKey(""), null);
});

test("parseScan never keeps a token from an origin url", () => {
  const scan = parseScan([
    "root\t/h/src",
    "/h/src/web\t1\thttps://user:secret@github.com/acme/web.git",
    "/h/src/web-fix\t0\tgit@github.com:acme/web.git",
    "/h/src/api\t1\tgit@github.com:acme/api.git",
  ].join("\n"));
  assert.deepEqual(scan.roots, ["/h/src"]);
  assert.equal(scan.repos.length, 3);
  assert.ok(!JSON.stringify(scan).includes("secret"));
  assert.equal(scan.repos.at(-1).main, false);
});

test("resolveRepo: picked, kaneo.json, Kaneo's git link, name, else ask", () => {
  const { repos } = parseScan("/h/src/web\t1\tgit@github.com:acme/web.git\n/h/src/web-fix\t0\tgit@github.com:acme/web.git\n/h/src/api\t1\t");
  const link = linkFrom("github", { repositoryOwner: "acme", repositoryName: "web", branchPattern: "{slug}-{number}", isActive: true });
  const project = { id: "p", slug: "WEB", name: "Website" };
  assert.equal(resolveRepo(project, { saved: { cwd: "/x" }, repos }).source, "picked");
  assert.equal(resolveRepo(project, { mapped: "/m", link, repos }).cwd, "/m");
  assert.deepEqual(resolveRepo(project, { link, repos, cloneRoot: "/h/src" }), { cwd: "/h/src/web", clone: null, source: "Kaneo github link" });
  assert.deepEqual(resolveRepo(project, { link, repos: [], cloneRoot: "/h/src" }),
    { cwd: "/h/src/web", clone: "git@github.com:acme/web.git", source: "clone from Kaneo github link" });
  assert.equal(resolveRepo({ id: "q", slug: "API", name: "Backend" }, { repos }).cwd, "/h/src/api");
  assert.equal(resolveRepo({ id: "r", slug: "OPS", name: "Ops" }, { repos }), null);
});

test("links from GitLab and Gitea, and what may be cloned", () => {
  assert.equal(linkFrom("gitlab", { baseUrl: "https://gitlab.example", projectPath: "g/app" }).key, "gitlab.example/g/app");
  assert.equal(linkFrom("gitea", { baseUrl: "http://gitea.lan:3000", repositoryOwner: "o", repositoryName: "n" }).cloneUrl, "http://gitea.lan:3000/o/n.git");
  assert.equal(linkFrom("github", null), null);
  assert.equal(cloneProblem("git@github.com:o/n.git"), null);
  assert.ok(cloneProblem("--upload-pack=touch /tmp/x"));
  assert.ok(cloneProblem("file:///etc"));
  assert.deepEqual(scanRoots({ repoRoots: ["~/a"] }, "/h"), ["/h/a"]);
});
