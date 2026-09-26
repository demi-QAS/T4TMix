/* =========================================================================
   T4T MIX — recipient runtime
   Hydrates from /api/tape/:id, drives the tactile world, plays the tape,
   handles the reply loop. Vanilla JS, no build step.
   ========================================================================= */
(function () {
  "use strict";

  const TAPE_ID = window.__TAPE_ID__;
  const $ = (id) => document.getElementById(id);
  const state = {
    tape: null,
    trackIdx: 0,
    playing: false,
    spotifyPlayer: null,
    spotifyReady: false,
    ytPlayer: null,
    audioEl: null,      // for podcast/audio + memos
    memoAudio: new Audio(),
    replyToken: null,   // returned after successful reply
    recording: null,    // { recorder, chunks, blob, url, seconds }
    replyPayload: null, // { kind: "voice"|"text", blob?, text? }
  };

  /* ---------- BOOT ---------- */
  async function boot() {
    if (!TAPE_ID || TAPE_ID === "__TAPE_ID__") {
      console.warn("No tape id");
      return;
    }
    try {
      const tape = await fetchTape(TAPE_ID);
      state.tape = tape;
      hydrateScene(tape);
      wireUnveiling();
      wireLetter(tape);
      wirePlayer(tape);
      wireReply(tape);
      wireWhatsThis();
      wireParallax();
    } catch (err) {
      console.error("Boot failed", err);
      document.body.innerHTML =
        '<div style="color:#fff;padding:40px;font-family:Inter,sans-serif;text-align:center">this mixtape isn\u2019t available. it may have expired.</div>';
    }
  }
  /* ---------- FETCH ---------- */
  async function fetchTape(id) {
    const r = await fetch(`/api/tape/${id}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("tape not found");
    return r.json();
  }
  function memoUrl(key) { return key ? `/api/memo/${encodeURIComponent(key)}` : null; }
  /* ---------- HYDRATE ---------- */
  function hydrateScene(t) {
    const scene = $("scene");
    scene.dataset.scene = t.scene || "desk";

    // Sender / recipient banners on unveiling
    $("unveilFrom").textContent = t.senderName ? `from ${t.senderName}` : "from someone";
    $("unveilFor").textContent = t.recipientName ? `for ${t.recipientName}` : "for you";

    // Tape face
    $("tapeTitleFront").textContent = titleOf(t);
    if (t.coverPhotoKey) {
      $("tapePhoto").style.backgroundImage = `url(${memoUrl(t.coverPhotoKey)})`;
    }

    // Shell skin
    const shell = $("playerShell");
    shell.classList.add(`shell-${t.shell || "cassette"}`);

    // Tracklist on back
    renderTracklistBack(t);

    // Memo sticky notes
    renderMemoNotes(t);
  }
  function titleOf(t) {
    return (t.playlist && t.playlist.title) || (t.contentType === "audio" ? "an episode for you" : "a mix for you");
  }
  function renderTracklistBack(t) {
    const box = $("tracklistBack");
    const tracks = t.tracks || [];
    if (!tracks.length) {
      box.innerHTML = '<div style="opacity:.6;padding:8px">no tracklist</div>';
      return;
    }
    box.innerHTML = tracks.map((tr, i) => {
      const has = tr.memoKey || tr.note ? "has" : "";
      return `<div class="row" data-i="${i}">
        <div class="num">${String(i+1).padStart(2,"0")}</div>
        <div class="title">${escapeHtml(tr.display || tr.original || "untitled")}</div>
        <div class="dot ${has}">${tr.memoKey ? "🎙️" : tr.note ? "📝" : "·"}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".row").forEach(r => {
      r.addEventListener("click", () => jumpToTrack(parseInt(r.dataset.i, 10)));
    });
  }
  function renderMemoNotes(t) {
    const box = $("memoNotes");
    const notes = (t.tracks || [])
      .map((tr, i) => ({ i, tr }))
      .filter(x => x.tr.memoKey || x.tr.note);
    if (!notes.length) { box.style.display = "none"; return; }
    box.innerHTML = notes.map(({ i, tr }) => {
      const cls = tr.memoKey ? "has-audio" : "has-note-only";
      const label = (tr.display || tr.original || `#${i+1}`).slice(0, 22);
      return `<button class="memo-note ${cls}" data-i="${i}">${escapeHtml(label)}</button>`;
    }).join("");
    box.querySelectorAll(".memo-note").forEach(b => {
      b.addEventListener("click", () => openMemo(parseInt(b.dataset.i, 10)));
    });
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }
  /* ---------- PARALLAX (tilt or touch fallback) ---------- */
  function wireParallax() {
    const scene = $("scene");
    let tx = 0, ty = 0;

    const set = (nx, ny) => {
      tx += (nx - tx) * 0.15; // smooth
      ty += (ny - ty) * 0.15;
      scene.style.setProperty("--tx", tx.toFixed(3));
      scene.style.setProperty("--ty", ty.toFixed(3));
    };

    const onOrient = (e) => {
      // gamma = left/right tilt (-90..90), beta = front/back (-180..180)
      const gx = clamp((e.gamma || 0) / 30, -1, 1);
      const gy = clamp(((e.beta || 0) - 45) / 30, -1, 1);
      set(gx, gy);
    };

    const startOrientation = () => {
      window.addEventListener("deviceorientation", onOrient, { passive: true });
    };

    // iOS 13+ needs a permission gesture
    const needsPermission =
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";

    if (needsPermission) {
      $("motionPrompt").classList.add("open");
      $("motionAllow").addEventListener("click", async () => {
        try {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res === "granted") startOrientation();
          else wireTouchFallback(set);
        } catch { wireTouchFallback(set); }
        $("motionPrompt").classList.remove("open");
      }, { once: true });
      $("motionSkip").addEventListener("click", () => {
        wireTouchFallback(set);
        $("motionPrompt").classList.remove("open");
      }, { once: true });
    } else if ("DeviceOrientationEvent" in window) {
      startOrientation();
    } else {
      wireTouchFallback(set);
    }
  }
  function wireTouchFallback(set) {
    // Drag anywhere on the scene → parallax
    const scene = $("scene");
    let dragging = false, sx = 0, sy = 0;
    scene.addEventListener("touchstart", (e) => {
      dragging = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    scene.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const dx = (e.touches[0].clientX - sx) / 120;
      const dy = (e.touches[0].clientY - sy) / 120;
      set(clamp(dx, -1, 1), clamp(dy, -1, 1));
    }, { passive: true });
    scene.addEventListener("touchend", () => { dragging = false; set(0, 0); });
    // mouse for desktop preview
    scene.addEventListener("mousemove", (e) => {
      const r = scene.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      const ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      set(nx * 0.6, ny * 0.6);
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /* ---------- UNVEILING (tap to unwrap) ---------- */
  function wireUnveiling() {
    const wrap = $("unveilWrapper");
    const veil = $("unveiling");
    wrap.addEventListener("click", () => {
      wrap.classList.add("opening");
      // little rustle
      try {
        const a = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YT9v"); // silent stub, replaced by real asset later
        a.volume = 0.25; a.play().catch(()=>{});
      } catch {}
      setTimeout(() => {
        veil.classList.add("hidden");
        // If sender wrote a letter, open it first — otherwise go straight to tape
        if (state.tape.letter && state.tape.letter.trim()) {
          openLetter();
        }
      }, 900);
    }, { once: true });
  }
  /* ---------- LETTER modal ---------- */
  function wireLetter(t) {
    const modal = $("letterModal");
    $("letterBody").textContent = t.letter || "";
    $("letterHeading").textContent = t.senderName
      ? `a note from ${t.senderName}`
      : "a note from your sender";
    $("letterClose").addEventListener("click", closeLetter);
    $("letterPlay").addEventListener("click", () => { closeLetter(); playToggle(true); });
    $("letterReply").addEventListener("click", () => { closeLetter(); openReply(); });
    // Tapping the folded letter prop reopens it
    const prop = $("letterProp");
    if (prop && (t.letter && t.letter.trim())) {
      prop.addEventListener("click", openLetter);
    } else if (prop) {
      prop.style.display = "none";
    }
  }
  function openLetter() { $("letterModal").classList.add("open"); }
  function closeLetter() { $("letterModal").classList.remove("open"); }
  /* ---------- PLAYER (Spotify SDK / YouTube iframe / raw audio) ---------- */
  function wirePlayer(t) {
    $("btnFlip").addEventListener("click", flipTape);
    $("btnPlay").addEventListener("click", () => playToggle());
    $("btnNext").addEventListener("click", nextTrack);
    updateNowPlaying();

    // Route by content type
    if (t.contentType === "audio" && t.audioUrl) {
      setupRawAudio(t.audioUrl);
    } else if (t.playlist && t.playlist.source === "spotify") {
      setupSpotifyLane(t.playlist);
    } else if (t.playlist && t.playlist.source === "youtube") {
      setupYouTubeLane(t.playlist);
    } else {
      // No playlist bound — memos-only tape ("just voice notes")
      console.info("Tape has no playlist; memo-only mode");
    }
  }
  function flipTape() {
    $("cassette").classList.toggle("flipped");
  }
  function playToggle(forcePlay) {
    const wantPlay = typeof forcePlay === "boolean" ? forcePlay : !state.playing;
    state.playing = wantPlay;
    $("cassette").classList.toggle("playing", wantPlay);
    $("btnPlay").textContent = wantPlay ? "❚❚" : "▶";
    if (state.audioEl) {
      wantPlay ? state.audioEl.play().catch(()=>{}) : state.audioEl.pause();
    }
    if (state.spotifyPlayer && state.spotifyReady) {
      wantPlay ? state.spotifyPlayer.resume() : state.spotifyPlayer.pause();
    }
    if (state.ytPlayer) {
      wantPlay ? state.ytPlayer.playVideo && state.ytPlayer.playVideo()
               : state.ytPlayer.pauseVideo && state.ytPlayer.pauseVideo();
    }
    if (wantPlay) maybePlayMemoAt("intro");
  }
  function nextTrack() {
    const tracks = state.tape.tracks || [];
    if (!tracks.length) return;
    state.trackIdx = (state.trackIdx + 1) % tracks.length;
    updateNowPlaying();
    maybePlayMemoAt("intro");
  }
  function jumpToTrack(i) {
    state.trackIdx = i;
    updateNowPlaying();
    playToggle(true);
    // Highlight in tracklist
    document.querySelectorAll(".tracklist-back .row").forEach((r, idx) =>
      r.classList.toggle("now", idx === i));
    maybePlayMemoAt("intro");
  }
  function updateNowPlaying() {
    const t = state.tape;
    const tr = (t.tracks || [])[state.trackIdx];
    if (!tr) { $("nowPlaying").innerHTML = ""; return; }
    $("nowPlaying").innerHTML =
      `<div class="np-track">${escapeHtml(tr.display || tr.original || "")}</div>
       <div class="np-original">${tr.original && tr.display && tr.original !== tr.display
          ? "originally: " + escapeHtml(tr.original) : ""}</div>`;
    document.querySelectorAll(".tracklist-back .row").forEach((r, idx) =>
      r.classList.toggle("now", idx === state.trackIdx));
  }

  /* --- Lanes --- */
  function setupRawAudio(url) {
    const a = new Audio(url);
    a.preload = "metadata";
    state.audioEl = a;
  }
  function setupSpotifyLane(pl) {
    // Detect Spotify Premium via SDK. Fall back to embed iframe if not premium
    // or if the SDK never authorizes (recipient not logged in).
    // NOTE: full OAuth flow is out of scope for v5; we render the embed iframe
    // as the honest default and offer a "Spotify Premium? play ad-free" toggle
    // that opens the SDK path in a follow-up build.
    const mount = document.createElement("div");
    mount.style.cssText = "position:absolute;left:0;right:0;bottom:-2px;height:80px;z-index:2;";
    mount.innerHTML = `<iframe
      style="border-radius:12px"
      src="https://open.spotify.com/embed/playlist/${encodeURIComponent(pl.id)}?utm_source=t4tmix"
      width="100%" height="80" frameborder="0" allowfullscreen=""
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"></iframe>`;
    $("playerShell").appendChild(mount);
  }
  function setupYouTubeLane(pl) {
    const mount = document.createElement("div");
    mount.style.cssText = "position:absolute;left:0;right:0;bottom:-2px;height:80px;z-index:2;";
    mount.innerHTML = `<iframe
      src="https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(pl.id)}"
      width="100%" height="80" frameborder="0"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowfullscreen loading="lazy"></iframe>`;
    $("playerShell").appendChild(mount);
  }
  /* ---------- MEMOS (voice notes at intro / outro / over-ad) ---------- */
  function openMemo(i) {
    const tr = state.tape.tracks[i];
    if (!tr) return;
    if (tr.memoKey) {
      state.memoAudio.src = memoUrl(tr.memoKey);
      state.memoAudio.play().catch(()=>{});
    } else if (tr.note) {
      // Text-only memo: pop as a floating note over the tape
      const div = document.createElement("div");
      div.className = "memo-note glow";
      div.style.cssText = "position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) rotate(-2deg);z-index:20;max-width:70%;padding:12px 14px;font-size:14px;";
      div.textContent = tr.note;
      div.addEventListener("click", () => div.remove());
      $("playerShell").appendChild(div);
      setTimeout(() => div.remove(), 6000);
    }
  }
  function maybePlayMemoAt(position) {
    const tr = state.tape.tracks[state.trackIdx];
    if (!tr) return;
    if (tr.memoPosition === position && tr.memoKey) {
      state.memoAudio.src = memoUrl(tr.memoKey);
      state.memoAudio.play().catch(()=>{});
    }
  }
  /* ---------- REPLY (one per tape: voice or text) ---------- */
  function wireReply(t) {
    if (t.replyTokenUsed) {
      $("btnReply").classList.add("hidden");
    } else {
      $("btnReply").classList.remove("hidden");
      $("btnReply").addEventListener("click", openReply);
    }

    // Tabs
    document.querySelectorAll(".reply-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".reply-tab").forEach(x => x.classList.remove("active"));
        document.querySelectorAll(".reply-pane").forEach(x => x.classList.remove("active"));
        tab.classList.add("active");
        document.querySelector(`.reply-pane[data-pane="${tab.dataset.tab}"]`).classList.add("active");
        updateReplySendEnabled();
      });
    });

    // Text
    $("replyText").addEventListener("input", () => {
      const v = $("replyText").value.trim();
      if (v) state.replyPayload = { kind: "text", text: v };
      else state.replyPayload = null;
      updateReplySendEnabled();
    });

    // Voice
    $("recBtn").addEventListener("click", toggleRecording);
    $("replySend").addEventListener("click", sendReply);
  }
  function openReply() { $("replyModal").classList.add("open"); }
  function closeReply() { $("replyModal").classList.remove("open"); }
  function updateReplySendEnabled() {
    $("replySend").disabled = !state.replyPayload;
  }

  async function toggleRecording() {
    if (state.recording && state.recording.recorder && state.recording.recorder.state === "recording") {
      state.recording.recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        state.recording.blob = blob;
        state.recording.url = URL.createObjectURL(blob);
        const el = $("recPlayback");
        el.src = state.recording.url;
        el.style.display = "block";
        $("recBtn").classList.remove("recording");
        $("recBtn").textContent = "●";
        state.replyPayload = { kind: "voice", blob, mime: mime || "audio/webm" };
        updateReplySendEnabled();
      };
      state.recording = { recorder, chunks, blob: null, url: null, seconds: 0 };
      recorder.start();
      $("recBtn").classList.add("recording");
      $("recBtn").textContent = "■";
      startRecTimer();
    } catch (err) {
      alert("mic permission denied. try the text tab instead.");
    }
  }
  function startRecTimer() {
    const MAX = 20;
    let s = 0;
    const iv = setInterval(() => {
      if (!state.recording || !state.recording.recorder ||
          state.recording.recorder.state !== "recording") {
        clearInterval(iv); return;
      }
      s += 1;
      state.recording.seconds = s;
      $("recTimer").textContent = `0:${String(s).padStart(2,"0")} / 0:20`;
      if (s >= MAX) {
        try { state.recording.recorder.stop(); } catch {}
        clearInterval(iv);
      }
    }, 1000);
  }

  async function sendReply() {
    if (!state.replyPayload) return;
    const btn = $("replySend");
    btn.disabled = true; btn.textContent = "sending…";
    try {
      const fd = new FormData();
      fd.append("kind", state.replyPayload.kind);
      if (state.replyPayload.kind === "text") {
        fd.append("text", state.replyPayload.text);
      } else {
        fd.append("audio", state.replyPayload.blob, "reply.webm");
      }
      const r = await fetch(`/api/tape/${TAPE_ID}/reply`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      // Success state
      $("replyCard").style.display = "none";
      $("replySuccess").classList.remove("hidden");
      $("btnReply").classList.add("hidden");
      setTimeout(closeReply, 2200);
    } catch (err) {
      alert("couldn't send. try again in a moment.");
      btn.disabled = false; btn.textContent = "send it";
    }
  }
  /* ---------- WHAT'S THIS? ---------- */
  function wireWhatsThis() {
    $("whatsThisBtn").addEventListener("click", () => $("whatsThisModal").classList.add("open"));
    $("wtClose").addEventListener("click", () => $("whatsThisModal").classList.remove("open"));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
