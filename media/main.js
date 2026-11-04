// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const record = $("record");
  const tonearm = $("tonearm");
  const labelArt = $("label-art");
  const artBg = $("art-bg");
  const titleEl = $("title");
  const titleSpan = titleEl.querySelector("span");
  const artistEl = $("artist");
  const progressEl = $("progress");
  const progressFill = $("progress-fill");
  const timeCur = $("time-cur");
  const timeTot = $("time-tot");
  const playPauseBtn = $("playpause");
  const repeatBtn = $("repeat");
  const libraryBtn = $("library");
  const noticeEl = $("notice");
  const connectBtn = $("connect");
  const playlistsBtn = $("playlists-btn");
  const playlistsEl = $("playlists");
  const queueBtn = $("queue-btn");
  const queueEl = $("queue");

  let playlistsVisible = false;
  let queueVisible = false;

  // current playback context, tracked so the queue can fetch / highlight correctly
  let ctxUri = undefined;
  let ctxType = undefined;
  let curTrackUri = undefined;
  let curLibraryUri = undefined;
  let trackSaved = undefined;
  let libraryPending = false;
  let libraryNotice = "";
  let playbackNotice = "";

  // ---- local progress clock (smooth ticking between polls) ----
  let durationMs = 0;
  let baseProgressMs = 0; // progress at last sync point
  let baseAt = 0; // performance.now() at last sync
  let playing = false;
  let scrubbing = false;
  let scrubFrac = 0;
  // after a seek, hold the optimistic position until Spotify catches up
  let seekLockUntil = 0;
  let seekTrackKey = "";

  let repeatState = "off";

  // ---- send commands ----
  $("prev").addEventListener("click", () => {
    // Like a normal music app: mid-song (>3s) → restart current track; otherwise → previous track.
    if (durationMs && currentMs() > 3000) {
      baseProgressMs = 0;
      baseAt = performance.now();
      seekLockUntil = performance.now() + 3000;
      seekTrackKey = trackKey();
      vscode.postMessage({ cmd: "seek", positionMs: 0 });
      paint();
    } else {
      vscode.postMessage({ cmd: "prev" });
    }
  });
  $("next").addEventListener("click", () => vscode.postMessage({ cmd: "next" }));
  playPauseBtn.addEventListener("click", () => vscode.postMessage({ cmd: "playPause" }));
  repeatBtn.addEventListener("click", () => {
    // cycle: off -> context (repeat all) -> track (repeat one) -> off
    const next = repeatState === "off" ? "context" : repeatState === "context" ? "track" : "off";
    vscode.postMessage({ cmd: "setRepeat", state: next });
  });
  libraryBtn.addEventListener("click", () => {
    if (libraryBtn.disabled || !curLibraryUri || typeof trackSaved !== "boolean") return;
    libraryPending = true;
    libraryNotice = "";
    renderLibraryButton();
    renderNotice();
    vscode.postMessage({ cmd: "setTrackSaved", uri: curLibraryUri, saved: !trackSaved });
  });
  connectBtn.addEventListener("click", () => {
    if (connectBtn.dataset.mode === "logout") {
      vscode.postMessage({ cmd: "logout" });
    } else {
      vscode.postMessage({ cmd: "login" });
    }
  });

  playlistsBtn.addEventListener("click", () => {
    setQueueVisible(false);
    playlistsVisible = !playlistsVisible;
    playlistsEl.classList.toggle("hidden", !playlistsVisible);
    playlistsBtn.classList.toggle("open", playlistsVisible);
    if (playlistsVisible) {
      vscode.postMessage({ cmd: "requestPlaylists" });
    }
  });

  queueBtn.addEventListener("click", () => {
    if (queueVisible) {
      setQueueVisible(false);
      return;
    }
    setPlaylistsVisible(false);
    setQueueVisible(true);
    if (ctxUri) {
      queueEl.innerHTML = "";
      vscode.postMessage({ cmd: "requestQueue", uri: ctxUri });
    }
  });

  function setPlaylistsVisible(on) {
    playlistsVisible = on;
    playlistsEl.classList.toggle("hidden", !on);
    playlistsBtn.classList.toggle("open", on);
  }

  function setQueueVisible(on) {
    queueVisible = on;
    queueEl.classList.toggle("hidden", !on);
    queueBtn.classList.toggle("open", on);
  }

  // ---- seek (click / drag on the bar) ----
  function fracFromEvent(e) {
    const rect = progressEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }
  progressEl.addEventListener("pointerdown", (e) => {
    if (!durationMs) return;
    scrubbing = true;
    progressEl.classList.add("scrubbing");
    try { progressEl.setPointerCapture(e.pointerId); } catch (_) {}
    scrubFrac = fracFromEvent(e);
    paintScrub();
  });
  progressEl.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    scrubFrac = fracFromEvent(e);
    paintScrub();
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    progressEl.classList.remove("scrubbing");
    const posMs = scrubFrac * durationMs;
    baseProgressMs = posMs; // optimistic: keep the knob where the user dropped it
    baseAt = performance.now();
    seekLockUntil = performance.now() + 3000;
    seekTrackKey = trackKey();
    vscode.postMessage({ cmd: "seek", positionMs: Math.round(posMs) });
    paint();
  };
  progressEl.addEventListener("pointerup", endScrub);
  progressEl.addEventListener("pointercancel", endScrub);

  // ---- receive state ----
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "state":
        renderState(msg.state);
        break;
      case "library":
        if (msg.state.uri !== curLibraryUri) break;
        trackSaved = msg.state.saved;
        libraryPending = msg.state.pending;
        libraryNotice = msg.state.notice || "";
        renderLibraryButton();
        renderNotice();
        break;
      case "playlists":
        renderPlaylists(msg.items);
        break;
      case "queue":
        renderQueue(msg);
        break;
      case "config":
        document.body.dataset.skin = msg.lpSkin;
        break;
      case "error":
        if (msg.message) noticeEl.textContent = msg.message;
        break;
    }
  });

  function setSpinning(on) {
    record.classList.toggle("paused", !on);
    tonearm.classList.toggle("on", on);
    playPauseBtn.textContent = on ? "❚❚" : "▶";
  }

  function renderRepeat(state) {
    repeatState = state || "off";
    // 🔂 = repeat one (track), 🔁 = repeat all (context) / off
    repeatBtn.textContent = repeatState === "track" ? "🔂" : "🔁";
    repeatBtn.classList.toggle("active", repeatState !== "off");
    repeatBtn.title =
      repeatState === "track" ? "Repeat: one" : repeatState === "context" ? "Repeat: all" : "Repeat: off";
  }

  function renderLibraryButton() {
    libraryBtn.textContent = trackSaved === true ? "♥"
      : trackSaved === false ? "⨁" : libraryPending ? "..." : "?";
    libraryBtn.classList.toggle("active", trackSaved === true);
    libraryBtn.disabled = libraryPending || typeof trackSaved !== "boolean";
    libraryBtn.title = libraryPending
      ? trackSaved === undefined
        ? "Checking Spotify library..."
        : "Updating Spotify library..."
      : trackSaved === true
        ? "Remove from Spotify library"
        : trackSaved === false ? "Save to Spotify library" : "Spotify library status unavailable";
    libraryBtn.setAttribute("aria-label", libraryBtn.title);
    libraryBtn.setAttribute("aria-pressed", String(trackSaved === true));
    libraryBtn.setAttribute("aria-busy", String(libraryPending));
  }

  function renderNotice() {
    noticeEl.textContent = libraryNotice || playbackNotice;
  }

  let curTrackName = "";
  let curArtist = "";
  function trackKey() {
    return curTrackName + " " + curArtist;
  }

  function renderState(s) {
    // connection UI
    if (!s.loggedIn) {
      connectBtn.textContent = "Connect Spotify";
      connectBtn.dataset.mode = "login";
      connectBtn.classList.remove("hidden");
      playlistsBtn.classList.add("hidden");
      queueBtn.classList.add("hidden");
    } else {
      connectBtn.textContent = "Disconnect";
      connectBtn.dataset.mode = "logout";
      connectBtn.classList.remove("hidden");
      playlistsBtn.classList.remove("hidden");
    }

    setSpinning(!!s.isPlaying);
    renderRepeat(s.repeatState);
    curTrackName = s.track || "";
    curArtist = s.artist || "";

    if (s.hasTrack) {
      setText(titleSpan, s.track || "");
      artistEl.textContent = s.artist || "";
      requestAnimationFrame(() => {
        titleEl.classList.toggle("scroll", titleSpan.scrollWidth > titleEl.clientWidth);
      });
      if (s.albumArt) {
        const url = `url("${s.albumArt}")`;
        labelArt.style.backgroundImage = url;
        artBg.style.backgroundImage = url;
        applyAlbumColor(s.albumArt);
      }
      // sync the local clock (holding optimistic position briefly after a seek)
      durationMs = s.durationMs || 0;
      let reported = s.progressMs || 0;
      const now = performance.now();
      if (seekLockUntil > now && seekTrackKey === trackKey()) {
        const optimistic = currentMs();
        if (Math.abs(reported - optimistic) > 1500) {
          reported = optimistic; // Spotify hasn't applied the seek yet — keep our value
        } else {
          seekLockUntil = 0; // caught up
        }
      }
      baseProgressMs = reported;
      baseAt = now;
      playing = !!s.isPlaying;
      if (!scrubbing) paint();
    } else {
      setText(titleSpan, s.loggedIn ? "Nothing playing" : "Not connected");
      artistEl.textContent = "";
      titleEl.classList.remove("scroll");
      labelArt.style.backgroundImage = "";
      artBg.style.backgroundImage = "";
      durationMs = 0;
      baseProgressMs = 0;
      playing = false;
      resetAlbumColor();
      if (!scrubbing) paint();
    }

    // ---- queue availability + sync ----
    const prevLibraryUri = curLibraryUri;
    curTrackUri = s.loggedIn && s.hasTrack ? s.trackUri : undefined;
    const libraryUri = s.libraryTrackUri ?? curTrackUri;
    const libraryAvailable = /^spotify:track:[A-Za-z0-9]+$/.test(curTrackUri || "")
      && /^spotify:track:[A-Za-z0-9]+$/.test(libraryUri || "");
    curLibraryUri = libraryAvailable ? libraryUri : undefined;
    libraryBtn.classList.toggle("hidden", !libraryAvailable);
    if (curLibraryUri !== prevLibraryUri || !libraryAvailable) {
      trackSaved = undefined;
      libraryPending = libraryAvailable;
      libraryNotice = "";
      renderLibraryButton();
    }
    const prevCtx = ctxUri;
    ctxUri = s.contextUri;
    ctxType = s.contextType;
    const queueable = s.loggedIn && s.hasTrack && ctxType === "playlist" && !!ctxUri;
    queueBtn.classList.toggle("hidden", !queueable);
    if (!queueable && queueVisible) {
      setQueueVisible(false);
    } else if (queueVisible && ctxUri && ctxUri !== prevCtx) {
      vscode.postMessage({ cmd: "requestQueue", uri: ctxUri });
    } else if (queueVisible) {
      highlightCurrent();
    }

    playbackNotice = s.notice || (s.deviceName && s.isPlaying ? "♪ " + s.deviceName : "");
    renderNotice();
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function renderQueue(msg) {
    queueEl.innerHTML = "";
    const tracks = msg.tracks || [];

    const head = document.createElement("div");
    head.className = "q-head";
    head.textContent = msg.name || "Tracks";
    queueEl.appendChild(head);

    if (!tracks.length) {
      const empty = document.createElement("div");
      empty.className = "pl-item";
      empty.textContent = "No tracks returned.";
      queueEl.appendChild(empty);
      return;
    }

    tracks.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "q-item";
      row.dataset.uri = t.uri;

      const num = document.createElement("span");
      num.className = "q-num";
      num.textContent = i + 1 + "";
      row.appendChild(num);

      const meta = document.createElement("span");
      meta.className = "q-meta";
      const name = document.createElement("span");
      name.className = "q-name";
      name.textContent = t.name;
      const artist = document.createElement("span");
      artist.className = "q-artist";
      artist.textContent = t.artist;
      meta.appendChild(name);
      meta.appendChild(artist);
      row.appendChild(meta);

      row.addEventListener("click", () => {
        vscode.postMessage({ cmd: "playTrack", contextUri: msg.uri, trackUri: t.uri });
      });
      queueEl.appendChild(row);
    });

    highlightCurrent();
  }

  function highlightCurrent() {
    const rows = queueEl.querySelectorAll(".q-item");
    let active = null;
    rows.forEach((row) => {
      const on = row.dataset.uri === curTrackUri;
      row.classList.toggle("playing", on);
      if (on) active = row;
    });
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  // ---- progress painting ----
  function currentMs() {
    if (scrubbing) return scrubFrac * durationMs;
    if (!playing) return baseProgressMs;
    return Math.min(durationMs, baseProgressMs + (performance.now() - baseAt));
  }

  function paint() {
    const cur = durationMs ? currentMs() : 0;
    const frac = durationMs > 0 ? Math.min(1, cur / durationMs) : 0;
    const pct = frac * 100 + "%";
    progressFill.style.width = pct;
    progressEl.style.setProperty("--knob-x", pct);
    timeCur.textContent = fmt(cur);
    timeTot.textContent = fmt(durationMs);
  }

  function paintScrub() {
    const cur = scrubFrac * durationMs;
    const pct = scrubFrac * 100 + "%";
    progressFill.style.width = pct;
    progressEl.style.setProperty("--knob-x", pct);
    timeCur.textContent = fmt(cur);
  }

  function fmt(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // advance the clock smoothly between polls
  setInterval(() => {
    if (playing && !scrubbing && durationMs) paint();
  }, 500);

  // ---- album-cover dominant color -> progress bar ----
  let lastArtUrl = "";
  function applyAlbumColor(url) {
    if (!url || url === lastArtUrl) return;
    lastArtUrl = url;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const n = 24;
        const canvas = document.createElement("canvas");
        canvas.width = n;
        canvas.height = n;
        const g = canvas.getContext("2d");
        g.drawImage(img, 0, 0, n, n);
        const color = dominant(g.getImageData(0, 0, n, n).data);
        document.documentElement.style.setProperty("--bar-color", color || "");
      } catch (_) {
        document.documentElement.style.removeProperty("--bar-color");
      }
    };
    img.onerror = () => document.documentElement.style.removeProperty("--bar-color");
    img.src = url;
  }
  function resetAlbumColor() {
    lastArtUrl = "";
    document.documentElement.style.removeProperty("--bar-color");
  }
  /** Pick a vivid, representative color: quantize pixels, weight by saturation. */
  function dominant(data) {
    const buckets = {};
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gg = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const lum = (r + gg + b) / 3;
      if (lum < 24 || lum > 236) continue; // skip near-black / near-white
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const key = (r >> 4) + "," + (gg >> 4) + "," + (b >> 4);
      const w = 1 + sat * 4; // strongly favor saturated buckets
      const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, w: 0 });
      bk.r += r * w;
      bk.g += gg * w;
      bk.b += b * w;
      bk.w += w;
    }
    let best = null;
    for (const k in buckets) {
      if (!best || buckets[k].w > best.w) best = buckets[k];
    }
    if (!best) return null;
    return `rgb(${Math.round(best.r / best.w)}, ${Math.round(best.g / best.w)}, ${Math.round(best.b / best.w)})`;
  }

  function renderPlaylists(items) {
    playlistsEl.innerHTML = "";
    if (!items || !items.length) {
      const empty = document.createElement("div");
      empty.className = "pl-item";
      empty.textContent = "No playlists found.";
      playlistsEl.appendChild(empty);
      return;
    }
    for (const p of items) {
      const row = document.createElement("div");
      row.className = "pl-item";

      if (p.imageUrl) {
        const img = document.createElement("img");
        img.src = p.imageUrl;
        img.alt = "";
        row.appendChild(img);
      }
      const name = document.createElement("span");
      name.className = "pl-name";
      name.textContent = p.name;
      row.appendChild(name);

      const count = document.createElement("span");
      count.className = "pl-count";
      count.textContent = p.trackCount + "";
      row.appendChild(count);

      row.addEventListener("click", () => {
        vscode.postMessage({ cmd: "playContext", uri: p.uri });
        playlistsVisible = false;
        playlistsEl.classList.add("hidden");
        playlistsBtn.classList.remove("open");
      });
      playlistsEl.appendChild(row);
    }
  }

  // tell host we're ready
  vscode.postMessage({ cmd: "ready" });
})();
