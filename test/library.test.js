const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const bundles = new Map();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function load(entry, { vscode, fetch, modules = {} } = {}) {
  if (!bundles.has(entry)) {
    bundles.set(entry, esbuild.buildSync({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["vscode"],
      write: false,
    }).outputFiles[0].text);
  }
  const module = { exports: {} };
  vm.runInNewContext(bundles.get(entry), {
    module,
    exports: module.exports,
    require: (id) => id === "vscode" ? vscode : modules[id] ?? require(id),
    fetch,
    Buffer,
    Error,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  }, { filename: entry });
  return module.exports;
}

function clientWith(fetch) {
  const { SpotifyClient } = load("src/spotify/client.ts", { fetch });
  return new SpotifyClient({ getAccessToken: async () => "test-token" });
}

function playback(uri = "A", overrides = {}) {
  return {
    loggedIn: true,
    isPlaying: true,
    hasTrack: true,
    track: `Track ${uri}`,
    artist: "Artist",
    trackUri: `spotify:track:${uri}`,
    durationMs: 180000,
    progressMs: 1000,
    ...overrides,
  };
}

function providerWith(overrides = {}) {
  let current = playback();
  let receive;
  let authChanged;
  const messages = [];
  const checks = [];
  const writes = [];
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => path.join(base, ...parts) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showErrorMessage() {} },
  };
  const client = {
    getPlaybackState: async () => current,
    isTrackSaved: async (uri) => {
      checks.push(uri);
      return overrides.isTrackSaved ? overrides.isTrackSaved(uri) : false;
    },
    setTrackSaved: async (uri, saved) => {
      writes.push({ uri, saved });
      if (overrides.setTrackSaved) await overrides.setTrackSaved(uri, saved);
    },
    play: async () => {},
    pause: async () => {},
    next: async () => {},
  };
  const auth = { onDidChange: (listener) => { authChanged = listener; return disposable; } };
  const { VinylViewProvider } = load("src/VinylViewProvider.ts", { vscode });
  const provider = new VinylViewProvider({ extensionUri: root, subscriptions: [] }, auth, client);
  provider.resolveWebviewView({
    visible: false,
    onDidChangeVisibility: () => disposable,
    onDidDispose: () => disposable,
    webview: {
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (listener) => { receive = listener; return disposable; },
      postMessage: (message) => {
        messages.push(structuredClone(message));
        return Promise.resolve(true);
      },
    },
  });
  return {
    provider,
    messages,
    checks,
    writes,
    authChanged: () => authChanged(true),
    setPlayback: (state) => { current = state; },
    poll: async () => { await provider.poller.pollNow(); await settle(); },
    send: async (message) => { await receive(message); await settle(); },
    library: () => messages.filter((message) => message.type === "library").at(-1)?.state,
    state: () => messages.filter((message) => message.type === "state").at(-1)?.state,
  };
}

function element() {
  const classes = new Set();
  return {
    textContent: "",
    dataset: {},
    attributes: {},
    listeners: {},
    disabled: false,
    clientWidth: 200,
    scrollWidth: 0,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector() { return this.span; },
    querySelectorAll() { return []; },
  };
}

function webview() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get("title").span = element();
  const button = get("library");
  button.disabled = true;
  button.classList.add("hidden");
  const commands = [];
  let receive;
  vm.runInNewContext(fs.readFileSync(path.join(root, "media/main.js"), "utf8"), {
    acquireVsCodeApi: () => ({ postMessage: (message) => commands.push({ ...message }) }),
    document: {
      getElementById: get,
      body: { dataset: {} },
      documentElement: element(),
    },
    window: { addEventListener: (_name, listener) => { receive = listener; } },
    performance: { now: () => 1000 },
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 0,
  });
  return {
    button,
    commands,
    notice: get("notice"),
    send: (message) => receive({ data: message }),
    click: () => button.listeners.click(),
  };
}

test("checks saved status with an encoded Spotify URI and preserves both boolean results", async () => {
  for (const saved of [false, true]) {
    const client = clientWith(async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://api.spotify.com");
      assert.equal(url.pathname, "/v1/me/library/contains");
      assert.equal(url.search, "?uris=spotify%3Atrack%3AA");
      assert.equal(init.method ?? "GET", "GET");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      return jsonResponse([saved]);
    });
    assert.equal(await client.isTrackSaved("spotify:track:A"), saved);
  }
});

test("saves and removes using the unified library endpoint without a playback device", async () => {
  const requests = [];
  const client = clientWith(async (input, init) => {
    requests.push({ url: new URL(input), ...init });
    return new Response(null, { status: 204 });
  });
  await client.setTrackSaved("spotify:track:A", true);
  await client.setTrackSaved("spotify:track:A", false);
  assert.deepEqual(requests.map((request) => request.method), ["PUT", "DELETE"]);
  for (const request of requests) {
    assert.equal(request.url.pathname, "/v1/me/library");
    assert.equal(request.url.searchParams.get("uris"), "spotify:track:A");
    assert.equal(request.body, undefined);
  }
});

test("rejects invalid library responses rather than treating them as unsaved", async () => {
  for (const data of [[], [true, false], [null], ["false"], { saved: true }, false]) {
    const client = clientWith(async () => jsonResponse(data));
    await assert.rejects(client.isTrackSaved("spotify:track:A"), /invalid library status/);
  }
});

test("rejects unsupported URIs before sending a library request", async () => {
  const client = clientWith(async () => assert.fail("Unexpected Spotify request"));
  for (const uri of [
    undefined,
    "spotify:local:artist:album:track:123",
    "spotify:episode:A",
    "spotify:track:",
    "spotify:track:A,spotify:track:B",
    "https://open.spotify.com/track/A",
  ]) {
    await assert.rejects(client.isTrackSaved(uri), /Only Spotify tracks/);
    await assert.rejects(client.setTrackSaved(uri, true), /Only Spotify tracks/);
  }
});

test("surfaces library permission, rate-limit, and HTTP failures explicitly", async () => {
  for (const [status, expected] of [
    [403, /Disconnect and reconnect Spotify.*library permissions/],
    [429, /Rate limited by Spotify/],
    [404, /Could not/],
    [500, /Could not/],
  ]) {
    const client = clientWith(async () => jsonResponse({ error: { message: "Denied" } }, status));
    await assert.rejects(client.isTrackSaved("spotify:track:A"), expected);
    await assert.rejects(client.setTrackSaved("spotify:track:A", true), expected);
    await assert.rejects(client.setTrackSaved("spotify:track:A", false), expected);
  }
});

test("checks on readiness and URI changes, but not unchanged playback polls", async () => {
  const view = providerWith({ isTrackSaved: async (uri) => uri === "spotify:track:B" });
  await view.send({ cmd: "ready" });
  assert.equal(view.library().saved, false);
  await view.poll();
  assert.deepEqual(view.checks, ["spotify:track:A"]);
  view.setPlayback(playback("B", { track: "Track A" }));
  await view.poll();
  assert.deepEqual(view.checks, ["spotify:track:A", "spotify:track:B"]);
  assert.equal(view.library().uri, "spotify:track:B");
  assert.equal(view.library().saved, true);
  await view.send({ cmd: "ready" });
  assert.equal(view.checks.length, 3);
});

test("updates library status through immediate and track-change playback refreshes", async () => {
  const view = providerWith();
  await view.poll();
  view.setPlayback(playback("B"));
  await view.provider.playPause();
  await settle();
  view.setPlayback(playback("C"));
  await view.provider.next();
  await settle();
  assert.deepEqual(view.checks, ["spotify:track:A", "spotify:track:B", "spotify:track:C"]);
});

test("confirms saves and removals and suppresses duplicate pending writes", async () => {
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const view = providerWith({ setTrackSaved: async (_uri, saved) => { if (saved) await pendingSave; } });
  await view.poll();
  const saving = view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  await settle();
  assert.equal(view.library().pending, true);
  assert.equal(view.library().saved, false);
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  assert.equal(view.writes.length, 1);
  finishSave();
  await saving;
  assert.equal(view.library().saved, true);
  assert.equal(view.library().pending, false);
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: false });
  assert.equal(view.library().saved, false);
  assert.deepEqual(view.writes, [
    { uri: "spotify:track:A", saved: true },
    { uri: "spotify:track:A", saved: false },
  ]);
});

test("retains confirmed status and reports failed library mutations", async () => {
  const view = providerWith({ setTrackSaved: async () => { throw new Error("Library update failed"); } });
  await view.poll();
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  assert.equal(view.library().saved, false);
  assert.equal(view.library().pending, false);
  assert.equal(view.library().notice, "Library update failed");
  assert.ok(view.messages.some((message) => message.type === "error" && message.message === "Library update failed"));
  await view.poll();
  assert.equal(view.library().notice, "Library update failed");
  assert.equal(view.checks.length, 1);
});

test("ignores a saved-status response for a previous track", async () => {
  let finishCheck;
  const pendingCheck = new Promise((resolve) => { finishCheck = resolve; });
  const view = providerWith({ isTrackSaved: async (uri) => uri === "spotify:track:A" ? pendingCheck : true });
  await view.poll();
  view.setPlayback(playback("B"));
  await view.poll();
  finishCheck(false);
  await settle();
  assert.equal(view.library().uri, "spotify:track:B");
  assert.equal(view.library().saved, true);
});

test("does not apply a previous track's save result to the new track", async () => {
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const view = providerWith({ setTrackSaved: async () => pendingSave });
  await view.poll();
  const saving = view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  await settle();
  view.setPlayback(playback("B"));
  await view.poll();
  finishSave();
  await saving;
  assert.equal(view.library().uri, "spotify:track:B");
  assert.equal(view.library().saved, false);
});

test("reuses a pending library mutation when the user returns to its track", async () => {
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const view = providerWith({ setTrackSaved: async () => pendingSave });
  await view.poll();
  const saving = view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  await settle();
  view.setPlayback(playback("B"));
  await view.poll();
  view.setPlayback(playback("A"));
  await view.poll();
  assert.deepEqual(view.checks, ["spotify:track:A", "spotify:track:B"]);
  assert.equal(view.library().pending, true);
  finishSave();
  await saving;
  assert.equal(view.library().uri, "spotify:track:A");
  assert.equal(view.library().saved, true);
});

test("invalidates cached and pending library state on authentication changes", async () => {
  let finishOldCheck;
  const oldCheck = new Promise((resolve) => { finishOldCheck = resolve; });
  let calls = 0;
  const view = providerWith({ isTrackSaved: async () => ++calls === 1 ? oldCheck : false });
  await view.poll();
  view.authChanged();
  await settle();
  finishOldCheck(true);
  await settle();
  assert.deepEqual(view.checks, ["spotify:track:A", "spotify:track:A"]);
  assert.equal(view.library().saved, false);
});

test("does not query or mutate unsupported, absent, or logged-out tracks", async () => {
  const view = providerWith();
  for (const state of [
    playback("A", { trackUri: "spotify:local:artist:album:track:123" }),
    playback("A", { trackUri: "spotify:episode:A" }),
    playback("A", { hasTrack: false }),
    playback("A", { loggedIn: false }),
  ]) {
    view.setPlayback(state);
    await view.poll();
    await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  }
  assert.equal(view.checks.length, 0);
  assert.equal(view.writes.length, 0);
});

test("retries failed saved-status checks without dropping playback", async () => {
  let fail = true;
  const view = providerWith({
    isTrackSaved: async () => {
      if (fail) throw new Error("Library lookup failed");
      return true;
    },
  });
  await view.poll();
  assert.equal(view.state().hasTrack, true);
  assert.equal(view.state().isPlaying, true);
  assert.equal(view.library().saved, undefined);
  assert.equal(view.library().notice, "Library lookup failed");
  fail = false;
  await view.poll();
  assert.equal(view.library().saved, true);
  assert.equal(view.library().notice, undefined);
});

test("rejects stale commands and invalid desired states", async () => {
  const view = providerWith();
  await view.poll();
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:B", saved: true });
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: "true" });
  await view.send({ cmd: "setTrackSaved", uri: "spotify:track:A", saved: false });
  assert.equal(view.writes.length, 0);
  assert.ok(view.messages.some((message) => message.type === "error" && /track changed/.test(message.message)));
  assert.ok(view.messages.some((message) => message.type === "error" && /Invalid Spotify library action/.test(message.message)));
});

test("the webview shows save/remove icons and locks pending actions across playback polls", () => {
  const ui = webview();
  assert.equal(ui.button.classList.contains("hidden"), true);
  ui.send({ type: "state", state: playback() });
  assert.equal(ui.button.disabled, true);
  ui.send({ type: "library", state: { uri: "spotify:track:A", pending: false, saved: false } });
  assert.equal(ui.button.textContent, "\u2a01");
  assert.equal(ui.button.title, "Save to Spotify library");
  assert.equal(ui.button.attributes["aria-pressed"], "false");
  ui.click();
  assert.deepEqual(ui.commands.at(-1), { cmd: "setTrackSaved", uri: "spotify:track:A", saved: true });
  assert.equal(ui.button.disabled, true);
  const count = ui.commands.length;
  ui.send({ type: "state", state: playback() });
  ui.click();
  assert.equal(ui.commands.length, count);
  ui.send({ type: "library", state: { uri: "spotify:track:A", pending: false, saved: true } });
  assert.equal(ui.button.textContent, "\u2665");
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.button.classList.contains("active"), true);
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  assert.equal(ui.button.attributes["aria-label"], "Remove from Spotify library");
  ui.click();
  assert.deepEqual(ui.commands.at(-1), { cmd: "setTrackSaved", uri: "spotify:track:A", saved: false });
  ui.send({ type: "library", state: { uri: "spotify:track:A", pending: false, saved: true, notice: "Removal failed" } });
  assert.equal(ui.button.textContent, "\u2665");
  assert.equal(ui.button.disabled, false);
  ui.send({ type: "state", state: playback() });
  assert.equal(ui.notice.textContent, "Removal failed");
});

test("the webview resets on song changes, ignores stale status, and hides unsupported items", () => {
  const ui = webview();
  ui.send({ type: "state", state: playback() });
  ui.send({ type: "library", state: { uri: "spotify:track:A", pending: false, saved: true } });
  ui.send({ type: "state", state: playback("B") });
  assert.equal(ui.button.textContent, "\u2a01");
  assert.equal(ui.button.disabled, true);
  ui.send({ type: "library", state: { uri: "spotify:track:A", pending: false, saved: true } });
  assert.equal(ui.button.disabled, true);
  for (const state of [
    playback("B", { trackUri: "spotify:local:artist:album:track:123" }),
    playback("B", { trackUri: "spotify:episode:B" }),
    playback("B", { hasTrack: false }),
    playback("B", { loggedIn: false }),
  ]) {
    ui.send({ type: "state", state });
    assert.equal(ui.button.classList.contains("hidden"), true);
    assert.equal(ui.button.disabled, true);
  }
});

test("OAuth authorization requests both library scopes and retains existing playback scopes", async () => {
  let callback;
  let authorization;
  const stored = new Map();
  const server = {
    on() {},
    close() {},
    listen(port, host, ready) {
      assert.equal(port, 9876);
      assert.equal(host, "127.0.0.1");
      ready();
    },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
    },
    Uri: { parse: (uri) => uri },
    ProgressLocation: { Notification: 1 },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => key === "spotifyClientId" ? "test-client" : fallback }),
    },
    window: {
      withProgress: (_options, work) => work({}, { onCancellationRequested() {} }),
      showInformationMessage() {},
    },
    env: {
      openExternal: (uri) => {
        authorization = new URL(uri);
        queueMicrotask(() => callback(
          { url: `/callback?code=test-code&state=${authorization.searchParams.get("state")}` },
          { writeHead() {}, end() {} }
        ));
        return Promise.resolve(true);
      },
    },
  };
  const { SpotifyAuth } = load("src/spotify/auth.ts", {
    vscode,
    modules: { http: { createServer: (handler) => { callback = handler; return server; } } },
    fetch: async () => jsonResponse({
      access_token: "test-access",
      refresh_token: "test-refresh",
      expires_in: 3600,
    }),
  });
  const auth = new SpotifyAuth({
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
    },
  });
  await auth.login();
  const scopes = authorization.searchParams.get("scope").split(" ");
  for (const scope of [
    "user-library-read",
    "user-library-modify",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-read-collaborative",
  ]) {
    assert.ok(scopes.includes(scope), `Missing scope: ${scope}`);
  }
  assert.equal(await auth.isLoggedIn(), true);
  assert.equal(await auth.getAccessToken(), "test-access");
});
