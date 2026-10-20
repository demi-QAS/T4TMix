/* =========================================================================
   T4T Mix — the deck (shared player for the sender preview + the gift page)
   -------------------------------------------------------------------------
   One player, three ways to make sound. OUR buttons drive all of them:
     • "spotify"  — Spotify's own embed, one song at a time (iFrame API).
                    Full songs if the listener is logged in to Spotify in
                    this browser, 30-second previews if not.
     • "youtube"  — YouTube's own player (IFrame API). Full songs, may show
                    ads. Spotify songs are matched to YouTube only when they
                    are actually played (/api/match), to save quota.
     • "preview"  — Spotify's 30-second preview clip in a plain <audio>.
   Provider players stay visible and are never covered (YouTube: ≥200×200).
   Phones sometimes refuse to start an embedded player from our button; when
   that happens the deck says so ("needsTap") instead of failing silently.
   ========================================================================= */
(function (global) {
  "use strict";

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src; s.async = true;
        s.onload = resolve; s.onerror = () => reject(new Error("couldn't load " + src));
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  let spotifyApiPromise = null;
  function spotifyApi() {
    if (!spotifyApiPromise) {
      spotifyApiPromise = new Promise((resolve, reject) => {
        const prev = global.onSpotifyIframeApiReady;
        global.onSpotifyIframeApiReady = (api) => { if (prev) try { prev(api); } catch (e) {} resolve(api); };
        loadScript("https://open.spotify.com/embed/iframe-api/v1").catch(reject);
        setTimeout(() => reject(new Error("spotify player didn't load")), 15000);
      });
    }
    return spotifyApiPromise;
  }

  let ytApiPromise = null;
  function youtubeApi() {
    if (!ytApiPromise) {
      ytApiPromise = new Promise((resolve, reject) => {
        if (global.YT && global.YT.Player) return resolve(global.YT);
        const prev = global.onYouTubeIframeAPIReady;
        global.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (e) {} resolve(global.YT); };
        loadScript("https://www.youtube.com/iframe_api").catch(reject);
        setTimeout(() => reject(new Error("youtube player didn't load")), 15000);
      });
    }
    return ytApiPromise;
  }

  class Deck {
    /**
     * opts.mount     element that hosts the provider player (keep it visible)
     * opts.tracks    [{ original, display, artist, spotifyId, ytVideoId, previewUrl, memoUrl, memoPosition }]
     * opts.source    "spotify" | "youtube" (where the playlist came from)
     * opts.apiBase   "" for same origin
     * opts.onChange  (state) => void   — called on every state change
     */
    constructor(opts) {
      this.mount = opts.mount;
      this.tracks = opts.tracks || [];
      this.source = opts.source || "spotify";
      this.apiBase = (opts.apiBase || "").replace(/\/$/, "");
      this.onChange = opts.onChange || (() => {});
      this.state = { index: 0, playing: false, loading: false, lane: null, needsTap: false, message: "", memo: false };
      this.lanes = this.availableLanes();
      this.memoAudio = new Audio();
      this.memoAudio.preload = "none";
      this.previewAudio = null;
      this.sp = null; this.spReady = null; this.spUri = null; this.spLast = null;
      this.yt = null; this.ytReady = null; this.ytVideo = null;
      this.matchCache = new Map();
      this.tapTimer = null;
      this.ended = false;
      this.setLane(this.lanes[0] || null, { silent: true });
    }

    availableLanes() {
      const t = this.tracks;
      const lanes = [];
      const hasSpotify = t.some((x) => x.spotifyId);
      const hasPreview = t.some((x) => x.previewUrl);
      if (this.source === "youtube") lanes.push("youtube");
      if (hasSpotify) lanes.push("spotify");
      if (this.source !== "youtube") lanes.push("youtube");
      if (hasPreview) lanes.push("preview");
      return [...new Set(lanes)];
    }

    emit(patch) {
      Object.assign(this.state, patch || {});
      try { this.onChange({ ...this.state, track: this.tracks[this.state.index] || null, lanes: this.lanes }); } catch (e) { console.error(e); }
    }
    current() { return this.tracks[this.state.index] || null; }
  }

  const P = Deck.prototype;

  /* ---------- lanes ---------- */
  P.setLane = function (lane, { silent } = {}) {
    if (!lane || lane === this.state.lane) { if (!silent) this.emit(); return; }
    const wasPlaying = this.state.playing;
    this.stopAll();
    this.state.lane = lane;
    this.mount.dataset.lane = lane;
    this.mount.querySelectorAll(".deck-slot").forEach((n) => { n.hidden = n.dataset.lane !== lane; });
    if (lane === "youtube") this.prefetchMatches();
    if (!silent) this.emit({ playing: false, needsTap: false, message: "" });
    if (wasPlaying && !silent) this.play();
  };
  P.slot = function (lane) {
    let n = this.mount.querySelector(`.deck-slot[data-lane="${lane}"]`);
    if (!n) {
      n = document.createElement("div");
      n.className = "deck-slot"; n.dataset.lane = lane;
      n.innerHTML = '<div class="deck-target"></div>';
      n.hidden = this.state.lane !== lane;
      this.mount.appendChild(n);
    }
    return n.querySelector(".deck-target") || n;
  };
  P.stopAll = function () {
    clearTimeout(this.tapTimer);
    try { this.memoAudio.pause(); } catch (e) {}
    if (this.previewAudio) try { this.previewAudio.pause(); } catch (e) {}
    if (this.sp) try { this.sp.pause(); } catch (e) {}
    if (this.yt && this.yt.pauseVideo) try { this.yt.pauseVideo(); } catch (e) {}
  };

  /* ---------- transport (all called from OUR buttons) ---------- */
  P.toggle = function () { return this.state.playing || this.state.loading ? this.pause() : this.play(); };
  P.pause = function () { this.stopAll(); this.emit({ playing: false, loading: false, memo: false }); };
  P.next = function (auto) { if (!this.tracks.length) return; this.jump((this.state.index + 1) % this.tracks.length, auto ? true : this.state.playing); };
  P.prev = function () { if (!this.tracks.length) return; this.jump((this.state.index - 1 + this.tracks.length) % this.tracks.length, this.state.playing); };
  P.jump = function (i, andPlay = true) {
    if (i < 0 || i >= this.tracks.length) return;
    this.stopAll();
    this.state.index = i; this.ended = false; this.memoDone = false;
    this.emit({ playing: false, needsTap: false, message: "" });
    if (this.state.lane === "youtube") this.prefetchMatches();
    if (andPlay) this.play();
  };
  P.play = function () {
    const t = this.current(); if (!t) return;
    this.emit({ loading: true, needsTap: false, message: "" });
    // the sender's voice memo plays first when it's an intro (or "over the ad")
    if (t.memoUrl && !this.memoDone && t.memoPosition !== "outro") {
      this.memoDone = true;
      this.playMemo(t.memoUrl, () => this.playSong());
      return;
    }
    this.playSong();
  };
  P.playMemo = function (url, after) {
    const a = this.memoAudio;
    a.onended = () => { this.emit({ memo: false }); after && after(); };
    a.onerror = () => { this.emit({ memo: false }); after && after(); };
    a.src = url;
    this.emit({ memo: true, playing: true, loading: false });
    a.play().catch(() => { this.emit({ memo: false }); after && after(); });
  };
  P.songEnded = function () {
    if (this.ended) return; this.ended = true;
    const t = this.current();
    if (t && t.memoUrl && t.memoPosition === "outro") this.playMemo(t.memoUrl, () => this.next(true));
    else this.next(true);
  };
  P.waitForSound = function (laneLabel) {
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      if (this.state.loading) this.emit({ loading: false, needsTap: true,
        message: `your phone wants one tap on the ${laneLabel} player below — after that our buttons take over` });
    }, 4500);
  };
  P.started = function () { clearTimeout(this.tapTimer); this.emit({ playing: true, loading: false, needsTap: false, message: "" }); };
  P.playSong = function () {
    const lane = this.state.lane;
    if (lane === "spotify") return this.playSpotify();
    if (lane === "youtube") return this.playYouTube();
    return this.playPreview();
  };

  /* ---------- preview lane ---------- */
  P.playPreview = function () {
    const t = this.current();
    if (!t || !t.previewUrl) { this.emit({ loading: false, message: "no preview for this one — skipping" }); return setTimeout(() => this.next(true), 900); }
    if (!this.previewAudio) {
      this.previewAudio = new Audio();
      this.previewAudio.addEventListener("playing", () => this.started());
      this.previewAudio.addEventListener("ended", () => this.songEnded());
      this.previewAudio.addEventListener("pause", () => { if (!this.ended && this.state.lane === "preview") this.emit({ playing: false }); });
    }
    if (this.previewAudio.src !== t.previewUrl) this.previewAudio.src = t.previewUrl;
    this.previewAudio.play().catch(() => this.emit({ loading: false, message: "tap play again to start the preview" }));
  };

  /* ---------- spotify lane ---------- */
  P.playSpotify = function () {
    const t = this.current();
    if (!t || !t.spotifyId) { this.emit({ loading: false, message: "this song isn't on Spotify — skipping" }); return setTimeout(() => this.next(true), 900); }
    const uri = `spotify:track:${t.spotifyId}`;
    this.ensureSpotify(uri).then((ctl) => {
      if (this.state.lane !== "spotify") return;
      if (this.spUri !== uri) { this.spUri = uri; ctl.loadUri(uri); setTimeout(() => ctl.play(), 500); }
      else ctl.resume();
      this.waitForSound("Spotify");
    }).catch(() => this.emit({ loading: false, message: "Spotify's player didn't load — try YouTube" }));
  };
  P.ensureSpotify = function (firstUri) {
    if (this.spReady) return this.spReady;
    const target = this.slot("spotify");
    this.spReady = spotifyApi().then((api) => new Promise((resolve) => {
      api.createController(target, { uri: firstUri, width: "100%", height: 152 }, (ctl) => {
        this.sp = ctl; this.spUri = firstUri;
        ctl.addListener("playback_update", (e) => {
          const d = e.data || {};
          if (this.state.lane !== "spotify") return;
          if (!d.isPaused && !d.isBuffering && d.position > 0) { if (!this.state.playing || this.state.loading) this.started(); }
          else if (d.isPaused && this.state.playing && !this.state.memo && !(d.duration && d.position >= d.duration - 1200)) this.emit({ playing: false });
          if (d.duration > 0 && d.position >= d.duration - 800 && !this.ended) this.songEnded();
          this.spLast = d;
        });
        resolve(ctl);
      });
    }));
    return this.spReady;
  };

  /* ---------- youtube lane ---------- */
  P.matchFor = function (t) {
    if (!t) return Promise.resolve(null);
    if (t.ytVideoId) return Promise.resolve(t.ytVideoId);
    const k = `${t.original || t.display}|${t.artist}`;
    if (!this.matchCache.has(k)) {
      const q = new URLSearchParams({ title: t.original || t.display || "", artist: t.artist || "" });
      this.matchCache.set(k, fetch(`${this.apiBase}/api/match?${q}`).then((r) => r.json()).then((d) => {
        if (d && d.videoId) t.ytVideoId = d.videoId;
        return (d && d.videoId) || null;
      }).catch(() => null));
    }
    return this.matchCache.get(k);
  };
  P.prefetchMatches = function () {
    const i = this.state.index;
    [i, i + 1].forEach((k) => this.matchFor(this.tracks[k % (this.tracks.length || 1)]));
  };
  P.playYouTube = function () {
    const t = this.current();
    this.matchFor(t).then((vid) => {
      if (this.state.lane !== "youtube" || t !== this.current()) return;
      if (!vid) {
        if (t.spotifyId && this.lanes.includes("spotify")) { this.emit({ message: "couldn't find this one on YouTube — playing it on Spotify" }); this.setLane("spotify"); return this.play(); }
        this.emit({ loading: false, message: "couldn't find this song on YouTube — skipping" });
        return setTimeout(() => this.next(true), 1200);
      }
      this.ensureYouTube(vid).then((p) => {
        if (this.ytVideo !== vid) { this.ytVideo = vid; p.loadVideoById(vid); } else p.playVideo();
        this.waitForSound("YouTube");
      }).catch(() => this.emit({ loading: false, message: "YouTube's player didn't load — try Spotify" }));
    });
  };
  P.ensureYouTube = function (firstVid) {
    if (this.ytReady) return this.ytReady;
    const target = this.slot("youtube");
    const holder = document.createElement("div"); target.appendChild(holder);
    this.ytReady = youtubeApi().then((YT) => new Promise((resolve) => {
      const p = new YT.Player(holder, {
        width: "100%", height: "200", videoId: firstVid,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { this.yt = p; this.ytVideo = firstVid; p.playVideo(); resolve(p); },
          onStateChange: (e) => {
            if (this.state.lane !== "youtube") return;
            if (e.data === 1) this.started();
            else if (e.data === 2 && !this.state.memo) this.emit({ playing: false, loading: false });
            else if (e.data === 0) this.songEnded();
          },
          onError: () => { this.emit({ message: "YouTube won't play this one here — skipping" }); setTimeout(() => this.next(true), 1200); },
        },
      });
    }));
    return this.ytReady;
  };

  P.destroy = function () {
    this.stopAll();
    try { this.sp && this.sp.destroy(); } catch (e) {}
    try { this.yt && this.yt.destroy(); } catch (e) {}
    this.mount.innerHTML = "";
  };

  global.T4TDeck = Deck;
})(window);
