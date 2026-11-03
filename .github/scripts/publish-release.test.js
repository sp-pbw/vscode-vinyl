const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { githubApi, publishRelease, releaseTag } = require("./publish-release");

const sha = "a".repeat(40);

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vinyl-release-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const artifact = join(directory, "vscode-vinyl.vsix");
  writeFileSync(artifact, "test package");
  const calls = [];
  const branch = options.branch || "main";
  const marker = `<!-- vinyl-branch:${Buffer.from(branch).toString("base64url")} -->`;
  const release = options.existing ? { id: 7, body: marker, ...options.release } : undefined;
  const args = {
    repo: "owner/repo",
    branch,
    sha,
    serverUrl: "https://github.com",
    runId: "123",
    artifact,
    api: async (path, method = "GET", data, optional = false) => {
      calls.push({ path, method, data, optional });
      if (path.includes("/git/ref/heads/")) {
        return options.deleted ? undefined : { object: { sha: options.head || sha } };
      }
      if (path.includes("/releases/tags/")) return release;
      if (path.includes("/git/ref/tags/")) {
        return options.existing || options.orphanTag ? { object: { sha: "b".repeat(40) } } : undefined;
      }
      if (method === "POST") return { id: 7 };
      return {};
    },
    upload: (...args) => {
      calls.push({ upload: args });
      if (options.uploadError) throw new Error("Asset upload failed");
    },
  };
  return { args, calls };
}

test("main has a stable download tag and other branch names cannot collide", () => {
  assert.equal(releaseTag("main"), "branch-main");
  const branches = ["Main", "feature/a", "feature-a", "feature_a", "feature/a/b", "feature/a.b", "feature/$(printf-test)", "a".repeat(200), "a".repeat(199) + "b"];
  const tags = branches.map(releaseTag);
  assert.equal(new Set(tags).size, branches.length);
  for (const [index, tag] of tags.entries()) {
    assert.match(tag, /^branch-[a-z0-9-]+-[a-f0-9]{12}$/);
    assert.ok(tag.length < 65);
    assert.equal(tag, releaseTag(branches[index]));
    assert.notEqual(tag, "branch-main");
  }
});

test("creates a draft, uploads the artifact, then publishes a prerelease with the exact source SHA", async (t) => {
  const { args, calls } = fixture(t);
  const result = await publishRelease(args);
  const create = calls.find((call) => call.method === "POST");
  assert.equal(create.path, "/repos/owner/repo/releases");
  assert.equal(create.data.tag_name, "branch-main");
  assert.equal(create.data.target_commitish, sha);
  assert.equal(create.data.draft, true);
  assert.equal(create.data.prerelease, true);
  assert.equal(create.data.make_latest, "false");
  const uploadIndex = calls.findIndex((call) => call.upload);
  const publishIndex = calls.findIndex((call) => call.method === "PATCH");
  assert.ok(calls.indexOf(create) < uploadIndex && uploadIndex < publishIndex);
  assert.deepEqual(calls[uploadIndex].upload, ["owner/repo", "branch-main", args.artifact]);
  const published = calls[publishIndex].data;
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, true);
  assert.equal(published.target_commitish, sha);
  assert.ok(published.body.includes(`/commit/${sha}`));
  assert.ok(published.body.includes("/actions/runs/123"));
  assert.ok(published.body.includes(createHash("sha256").update("test package").digest("hex")));
  assert.equal(result.downloadUrl, "https://github.com/owner/repo/releases/download/branch-main/vscode-vinyl.vsix");
});

test("updates a managed release in place and moves its tag after successful upload", async (t) => {
  const { args, calls } = fixture(t, { existing: true, branch: "feature/library" });
  const result = await publishRelease(args);
  assert.equal(calls.some((call) => call.method === "POST"), false);
  const uploadIndex = calls.findIndex((call) => call.upload);
  const moveIndex = calls.findIndex((call) => call.method === "PATCH" && call.path.includes("/git/refs/"));
  const publishIndex = calls.findIndex((call) => call.method === "PATCH" && call.path.endsWith("/releases/7"));
  assert.ok(uploadIndex < moveIndex && moveIndex < publishIndex);
  assert.deepEqual(calls[moveIndex].data, { sha, force: true });
  assert.equal(calls[0].path, "/repos/owner/repo/git/ref/heads/feature%2Flibrary");
  assert.ok(result.downloadUrl.includes(releaseTag("feature/library")));
});

test("does not publish stale reruns or deleted branches", async (t) => {
  for (const options of [{ head: "b".repeat(40) }, { deleted: true }]) {
    const { args, calls } = fixture(t, options);
    assert.equal(await publishRelease(args), undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  }
});

test("refuses to overwrite unrelated releases, immutable releases, or preexisting tags", async (t) => {
  for (const options of [
    { existing: true, release: { body: "A human-created release" } },
    { existing: true, release: { immutable: true } },
    { orphanTag: true },
  ]) {
    const { args, calls } = fixture(t, options);
    await assert.rejects(publishRelease(args), /Cannot (update|create)/);
    assert.equal(calls.some((call) => call.upload || call.method !== "GET"), false);
  }
});

test("a failed upload never moves the tag or publishes new release metadata", async (t) => {
  for (const existing of [false, true]) {
    const { args, calls } = fixture(t, { existing, uploadError: true });
    await assert.rejects(publishRelease(args), /Asset upload failed/);
    assert.equal(calls.some((call) => call.method === "PATCH"), false);
  }
});

test("branch names are encoded as API path data, not executed or interpolated as commands", async (t) => {
  const branch = "feature/$(touch-no-file);'quotes'";
  const { args, calls } = fixture(t, { branch });
  await publishRelease(args);
  assert.equal(calls[0].path, `/repos/owner/repo/git/ref/heads/${encodeURIComponent(branch)}`);
  const create = calls.find((call) => call.method === "POST");
  assert.equal(create.data.name, `Latest build: ${branch}`);
  assert.match(create.data.tag_name, /^branch-[a-z0-9-]+-[a-f0-9]{12}$/);
});

test("API client distinguishes an optional 404 from permission errors and other failures", async () => {
  for (const status of [403, 404, 422, 500]) {
    const api = githubApi("test-token", "https://api.github.com", async () => new Response("denied", { status }));
    await assert.rejects(api("/test"), new RegExp(`failed \\(${status}\\)`));
    if (status === 404) {
      assert.equal(await api("/test", "GET", undefined, true), undefined);
    } else {
      await assert.rejects(api("/test", "GET", undefined, true), new RegExp(`failed \\(${status}\\)`));
    }
  }
});

test("API client authenticates and serializes JSON, and handles empty success responses", async () => {
  const api = githubApi("test-token", "https://api.github.com", async (url, init) => {
    assert.equal(url, "https://api.github.com/test");
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { draft: false });
    return new Response(null, { status: 204 });
  });
  assert.equal(await api("/test", "PATCH", { draft: false }), undefined);
});

test("entry point refuses PR events and tag refs before contacting GitHub", () => {
  for (const [event, refType] of [["pull_request", "branch"], ["push", "tag"], ["workflow_dispatch", "tag"]]) {
    assert.throws(() => execFileSync(process.execPath, [join(__dirname, "publish-release.js")], {
      env: {
        GH_TOKEN: "test-token",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: "123",
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: refType,
      },
      stdio: "pipe",
    }), (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /only be published by branch pushes or manual branch builds/);
      return true;
    });
  }
});
