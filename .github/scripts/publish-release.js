const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");

function releaseTag(branch) {
  if (branch === "main") return "branch-main";
  const slug = branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 12);
  return `branch-${slug}-${hash}`;
}

function githubApi(token, baseUrl = "https://api.github.com", fetchImpl = fetch) {
  return async (path, method = "GET", data, optional = false) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (optional && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${await response.text()}`);
    }
    return response.status === 204 ? undefined : response.json();
  };
}

async function publishRelease({ repo, branch, sha, serverUrl, runId, artifact, api, upload }) {
  const prefix = `/repos/${repo}`;
  const head = await api(`${prefix}/git/ref/heads/${encodeURIComponent(branch)}`, "GET", undefined, true);
  if (!head || head.object.sha !== sha) {
    console.log("Skipping release: this build is no longer the branch head.");
    return undefined;
  }

  const tag = releaseTag(branch);
  const marker = `<!-- vinyl-branch:${Buffer.from(branch).toString("base64url")} -->`;
  const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const metadata = {
    name: `Latest build: ${branch}`,
    body: [
      marker,
      "Rolling prerelease, replaced after each successful build of this branch.",
      "",
      `Commit: ${serverUrl}/${repo}/commit/${sha}`,
      `Build: ${serverUrl}/${repo}/actions/runs/${runId}`,
      "",
      "Download **vscode-vinyl.vsix** below, then use **Extensions > ... > Install from VSIX** in VS Code.",
      "",
      `SHA-256: \`${digest}\``,
    ].join("\n"),
    prerelease: true,
    make_latest: "false",
  };
  let release = await api(`${prefix}/releases/tags/${tag}`, "GET", undefined, true);
  if (release && (!release.body?.includes(marker) || release.immutable)) {
    throw new Error(`Cannot update ${tag}: the release is not managed by this workflow or is immutable.`);
  }
  const ref = await api(`${prefix}/git/ref/tags/${tag}`, "GET", undefined, true);
  if (!release && ref) {
    throw new Error(`Cannot create ${tag}: the tag already exists without a managed release.`);
  }
  if (!release) {
    release = await api(`${prefix}/releases`, "POST", {
      ...metadata,
      tag_name: tag,
      target_commitish: sha,
      draft: true,
    });
  }

  // Upload before moving the tag or claiming that the new build is available.
  upload(repo, tag, artifact);
  if (ref) {
    await api(`${prefix}/git/refs/tags/${tag}`, "PATCH", { sha, force: true });
  }
  await api(`${prefix}/releases/${release.id}`, "PATCH", {
    ...metadata,
    target_commitish: sha,
    draft: false,
  });
  return {
    releaseUrl: `${serverUrl}/${repo}/releases/tag/${tag}`,
    downloadUrl: `${serverUrl}/${repo}/releases/download/${tag}/vscode-vinyl.vsix`,
  };
}

async function main() {
  const env = process.env;
  for (const key of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_REF_NAME", "GITHUB_SHA", "GITHUB_RUN_ID"]) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  if (env.GITHUB_REF_TYPE !== "branch" || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error("Releases can only be published by branch pushes or manual branch builds.");
  }
  const result = await publishRelease({
    repo: env.GITHUB_REPOSITORY,
    branch: env.GITHUB_REF_NAME,
    sha: env.GITHUB_SHA,
    serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    runId: env.GITHUB_RUN_ID,
    artifact: "vscode-vinyl.vsix",
    api: githubApi(env.GH_TOKEN, env.GITHUB_API_URL),
    upload: (repo, tag, artifact) => {
      execFileSync("gh", ["release", "upload", tag, artifact, "--repo", repo, "--clobber"], { stdio: "inherit" });
    },
  });
  if (result) {
    console.log(`Published ${result.releaseUrl}`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `## Branch download\n\n[Download VSIX](${result.downloadUrl}) | [Release](${result.releaseUrl})\n`);
    }
  }
}

module.exports = { githubApi, publishRelease, releaseTag };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
