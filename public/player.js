/* =========================================================================
   T4T Mix — the deck (shared player for the sender preview + the gift page)
   v0.8 — YouTube first, SoundCloud lane, sturdier voice memos.
   -------------------------------------------------------------------------
   OUR buttons drive every lane:
     • "youtube"     — YouTube IFrame API. Full songs, may show ads. DEFAULT.
                       Songs from Spotify / SoundCloud are matched on demand
                       (/api/match) and cached server-side.
     • "soundcloud"  — SoundCloud's Widget API. Full songs for tracks the
                       uploader allows; SoundCloud-sourced tapes always have ids,
                       other tapes only when SoundCloud search is configured.
     • "spotify"     — Spotify embed (full songs only if logged in).
     • "preview"     — Spotify 30-second clip in a plain <audio>.
   Voice memos: "intro" plays before the song, "outro" after, "over-ad" now
   plays OVER the first seconds of the song with the song turned down
   (YouTube + SoundCloud; Spotify can't change volume, so it behaves like intro).
   Every async callback is tagged with a generation number so a late event
   from a song you've already skipped can never start the wrong thing.
   ========================================================================= */
(function (global) {
  "use strict";

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src; s.async = true;
        s.onload = resolve; s.onerror = () => { delete scriptCache[src]; reject(new Error("couldn't load " + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }
  function withTimeout(p, ms, msg) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  }

  let spotifyApiPromise = null;
  function spotifyApi() {
    if (!spotifyApiPromise) {
      spotifyApiPromise = withTimeout(new Promise((resolve, reject) => {
        const prev = global.onSpotifyIframeApiReady;
        global.onSpotifyIframeApiReady = (api) => { if (prev) try { prev(api); } catch (e) {} resolve(api); };
        loadScript("https://open.spotify.com/embed/iframe-api/v1").catch(reject);
      }), 15000, "spotify player didn't load").catch((e) => { spotifyApiPromise = null; throw e; });
    }
    return spotifyApiPromise;
  }
  let ytApiPromise = null;
  function youtubeApi() {
    if (!ytApiPromise) {
      ytApiPromise = withTimeout(new Promise((resolve, reject) => {
        if (global.YT && global.YT.Player) return resolve(global.YT);
        const prev = global.onYouTubeIframeAPIReady;
        global.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (e) {} resolve(global.YT); };
        loadScript("https://www.youtube.com/iframe_api").catch(reject);
      }), 15000, "youtube player didn't load").catch((e) => { ytApiPromise = null; throw e; });
    }
    return ytApiPromise;
  }
  let scApiPromise = null;
  function soundcloudApi() {
    if (!scApiPromise) {
      scApiPromise = withTimeout((global.SC && global.SC.Widget) ? Promise.resolve(global.SC)
        : loadScript("https://w.soundcloud.com/player/api.js").then(() => global.SC), 15000, "soundcloud player didn't load")
        .catch((e) => { scApiPromise = null; throw e; });
    }
    return scApiPromise;
  }

  const DUCK = 18;          // song volume (0-100) while an "over" memo talks
  const ALL_LANES = ["youtube", "soundcloud", "spotify", "preview"];

  class Deck {
    /**
     * opts.mount       element that hosts the provider player (keep it visible)
     * opts.tracks      [{ original, display, artist, spotifyId, ytVideoId, scId, previewUrl, memoUrl, memoPosition }]
     * opts.source      "spotify" | "youtube" | "soundcloud" (where the playlist came from)
     * opts.apiBase     "" for same origin
     * opts.lanesAllowed { youtube:true, soundcloud:true, spotify:true, preview:true } (admin switches)
     * opts.defaultLane "youtube" (admin setting)
     * opts.onChange    (state) => void
     */
    constructor(opts) {
      this.mount = opts.mount;
      this.tracks = opts.tracks || [];
      this.source = opts.source || "spotify";
      this.apiBase = (opts.apiBase || "").replace(/\/$/, "");
      this.allowed = Object.assign({ youtube: true, soundcloud: true, spotify: true, preview: true }, opts.lanesAllowed || {});
      this.defaultLane = opts.defaultLane || "youtube";
      this.onChange = opts.onChange || (() => {});
      this.state = { index: 0, playing: false, loading: false, lane: null, needsTap: false, message: "", memo: false };
      this.gen = 0;                    // bumps on every jump / lane change / pause
      this.memoAudio = new Audio();
      this.memoAudio.preload = "auto";
      this.memoState = null;           // { gen, url, after, paused }
      this.memoDone = false;
      this.previewAudio = null;
      this.sp = null; this.spReady = null; this.spUri = null;
      this.yt = null; this.ytReady = null; this.ytVideo = null;
      this.sc = null; this.scReady = null; this.scTrack = null; this.scSetUrl = opts.scSetUrl || null;
      this.matchCache = new Map();
      this.tapTimer = null;
      this.ended = false;
      this.scSearch = !!opts.scSearch;
      this.lanes = this.availableLanes();
      this.preferredLane = this.pickStartLane();
      this.setLane(this.preferredLane, { silent: true });
    }

    availableLanes() {
      const t = this.tracks;
      const has = {
        youtube: true, // anything can be matched to YouTube
        soundcloud: this.source === "soundcloud" || t.some((x) => x.scId) || this.scSearch,
        spotify: t.some((x) => x.spotifyId),
        preview: t.some((x) => x.previewUrl),
      };
      const lanes = ALL_LANES.filter((l) => has[l] && this.allowed[l] !== false);
      return lanes.length ? lanes : ["youtube"];
    }
    pickStartLane() {
      if (this.lanes.includes(this.defaultLane)) return this.defaultLane;
      return this.lanes[0] || null;
    }
    emit(patch) {
      Object.assign(this.state, patch || {});
      try { this.onChange({ ...this.state, track: this.tracks[this.state.index] || null, lanes: this.lanes }); } catch (e) { console.error(e); }
    }
    current() { return this.tracks[this.state.index] || null; }
    live(g) { return g === this.gen; }
  }

  const P = Deck.prototype;

  /* ---------- lanes ---------- */
  P.setLane = function (lane, { silent } = {}) {
    if (!silent && lane) this.preferredLane = lane; // the listener's own pick sticks
    if (!lane || lane === this.state.lane) { if (!silent) this.emit(); return; }
    const wasPlaying = this.state.playing && !this.state.memo;
    this.stopAll();
    this.state.lane = lane;
    this.mount.dataset.lane = lane;
    this.mount.querySelectorAll(".deck-slot").forEach((n) => { n.hidden = n.dataset.lane !== lane; });
    if (lane === "youtube" || lane === "soundcloud") this.prefetchMatches();
    if (!silent) this.emit({ playing: false, loading: false, memo: false, needsTap: false, message: "" });
    if (wasPlaying && !silent) { this.memoDone = true; this.play(); }
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
    this.gen++;
    clearTimeout(this.tapTimer);
    try { this.memoAudio.pause(); } catch (e) {}
    if (this.previewAudio) try { this.previewAudio.pause(); } catch (e) {}
    if (this.sp) try { this.sp.pause(); } catch (e) {}
    if (this.yt && this.yt.pauseVideo) try { this.yt.pauseVideo(); } catch (e) {}
    if (this.ytPrimed && this.yt) { try { this.yt.unMute(); } catch (e) {} }
    if (this.sc) try { this.sc.pause(); } catch (e) {}
    this.unduck();
  };

  /* ---------- transport ---------- */
  P.toggle = function () { return this.state.playing || this.state.loading ? this.pause() : this.play(); };
  P.pause = function () {
    // remember a half-played memo so play() picks it back up instead of skipping it
    if (this.state.memo && this.memoState) this.memoState.paused = true;
    this.stopAll();
    this.emit({ playing: false, loading: false, memo: false });
  };
  P.next = function (auto) { if (!this.tracks.length) return; this.jump((this.state.index + 1) % this.tracks.length, auto ? true : this.state.playing); };
  P.prev = function () { if (!this.tracks.length) return; this.jump((this.state.index - 1 + this.tracks.length) % this.tracks.length, this.state.playing); };
  P.jump = function (i, andPlay = true) {
    if (i < 0 || i >= this.tracks.length) return;
    this.stopAll();
    this.state.index = i; this.ended = false; this.memoDone = false; this.memoState = null;
    // a fallback only covers the one song — go back to the listener's lane
    if (this.preferredLane && this.state.lane !== this.preferredLane && this.lanes.includes(this.preferredLane)) this.setLane(this.preferredLane, { silent: true });
    this.emit({ playing: false, loading: false, memo: false, needsTap: false, message: "" });
    if (this.state.lane === "youtube" || this.state.lane === "soundcloud") this.prefetchMatches();
    if (andPlay) this.play();
  };
  P.play = function () {
    const t = this.current(); if (!t) return;
    const g = ++this.gen;
    this.emit({ loading: true, needsTap: false, message: "" });
    // resume a memo that was paused halfway
    if (this.memoState && this.memoState.paused && this.memoState.url === t.memoUrl) {
      this.memoState.paused = false;
      const mode = this.memoState.mode;
      if (mode === "over") { this.playMemo(t.memoUrl, null, g, true, "over"); return this.playSong(g, { duck: true }); }
      const after = mode === "outro" ? () => this.next(true) : () => this.playSong(g);
      return this.playMemo(t.memoUrl, after, g, true, mode);
    }
    if (t.memoUrl && !this.memoDone && t.memoPosition !== "outro") {
      this.memoDone = true;
      const over = t.memoPosition === "over-ad" && (this.state.lane === "youtube" || this.state.lane === "soundcloud");
      if (over) { this.playMemo(t.memoUrl, null, g, false, "over"); return this.playSong(g, { duck: true }); }
      this.primeYouTube(t);
      return this.playMemo(t.memoUrl, () => this.playSong(g), g, false, "intro");
    }
    this.playSong(g);
  };
  P.playMemo = function (url, after, g, resume, mode) {
    const a = this.memoAudio;
    this.memoState = { url, mode: mode || "intro", paused: false };
    const token = (this.memoToken = (this.memoToken || 0) + 1);
    const finish = () => {
      // a memo that was cut off (skip / pause) must not touch the NEXT memo's handlers
      if (token !== this.memoToken || !this.live(g)) return;
      a.onended = a.onerror = null;
      const pendingNext = this.memoState && this.memoState.pendingNext;
      this.memoState = null;
      this.emit({ memo: false });
      if (mode === "over") this.unduck(!pendingNext);
      if (pendingNext) return this.next(true); // the song finished first; the memo got to finish its sentence
      if (after) after();
    };
    a.onended = finish;
    a.onerror = finish;
    if (!resume || a.src.indexOf(url) === -1) { a.src = url; }
    this.emit({ memo: true, playing: true, loading: false });
    const p = a.play();
    if (p && p.catch) p.catch(() => finish());
  };
  // Phones only let a player start from a real tap. When a voice memo plays first, the
  // song would start ~20s after the tap and get blocked. So, inside the tap, we start
  // the (already warmed-up) YouTube player MUTED, then rewind + unmute when the memo ends.
  P.primeYouTube = function (t) {
    if (this.state.lane !== "youtube" || !this.yt || this.ytUnlocked) return;
    try { this.yt.mute(); this.yt.playVideo(); this.ytPrimed = true; this.ytUnlocked = true; } catch (e) {}
  };
  // Build the YouTube player for the first song ahead of time (no sound, no autoplay).
  P.warm = function () {
    if (this.state.lane !== "youtube" || this.ytReady) return;
    const t = this.tracks[this.state.index];
    this.matchFor(t, "youtube").then((vid) => { if (vid && !this.ytReady && this.state.lane === "youtube") this.ensureYouTube(vid).catch(() => {}); });
  };
  P.songEnded = function (g) {
    if (g !== undefined && !this.live(g)) return;
    if (this.ended) return; this.ended = true;
    // an "over" memo still talking when the song ends: let it finish, then move on
    if (this.state.memo && this.memoState && this.memoState.mode === "over") { this.memoState.pendingNext = true; return; }
    const t = this.current();
    if (t && t.memoUrl && t.memoPosition === "outro") {
      const g2 = ++this.gen;
      this.playMemo(t.memoUrl, () => this.next(true), g2, false, "outro");
    } else this.next(true);
  };
  P.waitForSound = function (laneLabel, g) {
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      if (this.live(g) && this.state.loading) this.emit({ loading: false, needsTap: true,
        message: `your phone wants one tap on the ${laneLabel} player below — after that our buttons take over` });
    }, 4500);
  };
  P.started = function () {
    clearTimeout(this.tapTimer);
    // during an "over" memo the song plays underneath; keep the memo label up
    this.emit({ playing: true, loading: false, needsTap: false, message: "" });
  };
  P.skipSoon = function (g, msg, ms = 1100) {
    this.emit({ loading: false, message: msg });
    setTimeout(() => { if (this.live(g)) this.next(true); }, ms);
  };
  P.playSong = function (g, opts) {
    if (!this.live(g)) return;
    const lane = this.state.lane;
    if (lane === "youtube") return this.playYouTube(g, opts);
    if (lane === "soundcloud") return this.playSoundCloud(g, opts);
    if (lane === "spotify") return this.playSpotify(g);
    return this.playPreview(g);
  };
  P.duck = function () {
    clearInterval(this.fadeTimer);
    this.ducked = true;
    if (this.state.lane === "youtube" && this.yt && this.yt.setVolume) try { this.yt.setVolume(DUCK); } catch (e) {}
    if (this.state.lane === "soundcloud" && this.sc) try { this.sc.setVolume(DUCK); } catch (e) {}
  };
  P.unduck = function (fade) {
    if (!this.ducked) return;
    this.ducked = false;
    clearInterval(this.fadeTimer);
    const set = (v) => {
      if (this.yt && this.yt.setVolume) try { this.yt.setVolume(v); } catch (e) {}
      if (this.sc) try { this.sc.setVolume(v); } catch (e) {}
    };
    if (!fade) return set(100);
    let v = DUCK;
    this.fadeTimer = setInterval(() => { v = Math.min(100, v + 12); set(v); if (v >= 100) clearInterval(this.fadeTimer); }, 80);
  };

  /* ---------- preview lane ---------- */
  P.playPreview = function (g) {
    const t = this.current();
    if (!t || !t.previewUrl) return this.skipSoon(g, "no preview for this one — skipping", 900);
    if (!this.previewAudio) {
      this.previewAudio = new Audio();
      this.previewAudio.addEventListener("playing", () => this.started());
      this.previewAudio.addEventListener("ended", () => this.songEnded());
      this.previewAudio.addEventListener("pause", () => { if (!this.ended && this.state.lane === "preview" && !this.state.memo) this.emit({ playing: false }); });
    }
    if (this.previewAudio.src !== t.previewUrl) this.previewAudio.src = t.previewUrl;
    this.previewAudio.play().catch(() => { if (this.live(g)) this.emit({ loading: false, message: "tap play again to start the preview" }); });
  };

  /* ---------- spotify lane ---------- */
  P.playSpotify = function (g) {
    const t = this.current();
    if (!t || !t.spotifyId) return this.skipSoon(g, "this song isn't on Spotify — skipping", 900);
    const uri = `spotify:track:${t.spotifyId}`;
    this.ensureSpotify(uri).then((ctl) => {
      if (!this.live(g) || this.state.lane !== "spotify") return;
      if (this.spUri !== uri) { this.spUri = uri; ctl.loadUri(uri); setTimeout(() => { if (this.live(g)) ctl.play(); }, 500); }
      else ctl.resume();
      this.waitForSound("Spotify", g);
    }).catch(() => { if (this.live(g)) this.emit({ loading: false, message: "Spotify's player didn't load — try YouTube" }); });
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
        });
        resolve(ctl);
      });
    })).catch((e) => { this.spReady = null; throw e; });
    return this.spReady;
  };

  /* ---------- matching ---------- */
  P.matchFor = function (t, provider) {
    if (!t) return Promise.resolve(null);
    const field = provider === "soundcloud" ? "scId" : "ytVideoId";
    if (t[field]) return Promise.resolve(t[field]);
    const k = `${provider}|${t.original || t.display}|${t.artist}`;
    if (!this.matchCache.has(k)) {
      const q = new URLSearchParams({ title: t.original || t.display || "", artist: t.artist || "", provider });
      this.matchCache.set(k, fetch(`${this.apiBase}/api/match?${q}`).then((r) => r.json()).then((d) => {
        const id = provider === "soundcloud" ? d && d.scId : d && d.videoId;
        if (id) t[field] = id;
        else this.matchCache.delete(k); // allow a retry later (quota may come back)
        return id || null;
      }).catch(() => { this.matchCache.delete(k); return null; }));
    }
    return this.matchCache.get(k);
  };
  P.prefetchMatches = function () {
    const i = this.state.index, n = this.tracks.length || 1;
    const provider = this.state.lane === "soundcloud" ? "soundcloud" : "youtube";
    [i, i + 1].forEach((k) => this.matchFor(this.tracks[k % n], provider));
  };
  P.fallbackFrom = function (lane, g, t) {
    // a song that can't play on this lane: try the next-best lane for THIS song only
    const order = lane === "youtube" ? ["soundcloud", "spotify", "preview"] : ["youtube", "spotify", "preview"];
    for (const l of order) {
      if (!this.lanes.includes(l)) continue;
      if (l === "spotify" && !t.spotifyId) continue;
      if (l === "preview" && !t.previewUrl) continue;
      if (l === "soundcloud" && !t.scId) continue;
      this.emit({ message: `couldn't find this one on ${lane === "youtube" ? "YouTube" : "SoundCloud"} — playing it on ${l === "youtube" ? "YouTube" : l === "soundcloud" ? "SoundCloud" : l === "spotify" ? "Spotify" : "a preview"}` });
      this.setLane(l, { silent: true }); this.emit();
      this.memoDone = true;
      return this.play();
    }
    this.skipSoon(g, `couldn't find this song on ${lane === "youtube" ? "YouTube" : "SoundCloud"} — skipping`, 1200);
  };

  /* ---------- youtube lane ---------- */
  P.playYouTube = function (g, opts) {
    const t = this.current();
    this.matchFor(t, "youtube").then((vid) => {
      if (!this.live(g) || this.state.lane !== "youtube" || t !== this.current()) return;
      if (!vid) return this.fallbackFrom("youtube", g, t);
      this.ensureYouTube(vid, g).then((p) => {
        if (!this.live(g)) return;
        if (opts && opts.duck) this.duck();
        this.ytUnlocked = true;
        if (this.ytPrimed) { this.ytPrimed = false; try { p.unMute(); } catch (e) {} if (this.ytVideo === vid) try { p.seekTo(0, true); } catch (e) {} }
        if (this.ytVideo !== vid) { this.ytVideo = vid; p.loadVideoById(vid); } else p.playVideo();
        this.waitForSound("YouTube", g);
      }).catch(() => { if (this.live(g)) this.emit({ loading: false, message: "YouTube's player didn't load — check your connection and tap play" }); });
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
          onReady: () => { this.yt = p; this.ytVideo = firstVid; resolve(p); },
          onStateChange: (e) => {
            if (this.state.lane !== "youtube") return;
            if (this.ytPrimed) return; // muted warm-up under an intro memo — ignore
            if (e.data === 1) this.started();
            else if (e.data === 2 && !this.state.memo && this.state.playing) this.emit({ playing: false, loading: false });
            else if (e.data === 0) this.songEnded();
          },
          onError: () => {
            if (this.state.lane !== "youtube") return;
            const g = this.gen;
            const t = this.current();
            if (t) t.ytVideoId = null;
            this.fallbackFrom("youtube", g, t || {});
          },
        },
      });
    })).catch((e) => { this.ytReady = null; throw e; });
    return this.ytReady;
  };

  /* ---------- soundcloud lane ---------- */
  P.playSoundCloud = function (g, opts) {
    const t = this.current();
    this.matchFor(t, "soundcloud").then((id) => {
      if (!this.live(g) || this.state.lane !== "soundcloud" || t !== this.current()) return;
      if (!id) return this.fallbackFrom("soundcloud", g, t);
      this.ensureSoundCloud(id).then((w) => {
        if (!this.live(g)) return;
        const go = () => { if (!this.live(g)) return; if (opts && opts.duck) this.duck(); w.play(); this.waitForSound("SoundCloud", g); };
        if (this.scTrack !== id) {
          this.scTrack = id;
          w.load(`https://api.soundcloud.com/tracks/${id}`, { auto_play: false, show_artwork: true, visual: false, color: "#e63a7a", buying: false, sharing: false, download: false, show_comments: false, callback: go });
        } else go();
      }).catch(() => { if (this.live(g)) this.emit({ loading: false, message: "SoundCloud's player didn't load — try YouTube" }); });
    });
  };
  P.ensureSoundCloud = function (firstId) {
    if (this.scReady) return this.scReady;
    const target = this.slot("soundcloud");
    this.scReady = soundcloudApi().then((SC) => new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.width = "100%"; f.height = "166"; f.allow = "autoplay; encrypted-media"; f.setAttribute("frameborder", "no"); f.setAttribute("scrolling", "no");
      f.title = "SoundCloud player";
      f.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://api.soundcloud.com/tracks/${firstId}`)}&auto_play=false&visual=false&color=%23e63a7a&buying=false&sharing=false&download=false&show_comments=false`;
      target.appendChild(f);
      const w = SC.Widget(f);
      const E = SC.Widget.Events;
      w.bind(E.READY, () => { this.sc = w; this.scTrack = firstId; resolve(w); });
      w.bind(E.PLAY, () => { if (this.state.lane === "soundcloud") this.started(); });
      w.bind(E.PAUSE, () => { if (this.state.lane === "soundcloud" && !this.state.memo && this.state.playing && !this.ended) this.emit({ playing: false }); });
      w.bind(E.FINISH, () => { if (this.state.lane === "soundcloud") this.songEnded(); });
      w.bind(E.ERROR, () => { if (this.state.lane === "soundcloud") { const t = this.current(); if (t) t.scId = null; this.fallbackFrom("soundcloud", this.gen, t || {}); } });
    })).catch((e) => { this.scReady = null; throw e; });
    return this.scReady;
  };

  P.destroy = function () {
    this.stopAll();
    clearInterval(this.fadeTimer);
    try { this.sp && this.sp.destroy(); } catch (e) {}
    try { this.yt && this.yt.destroy(); } catch (e) {}
    this.mount.innerHTML = "";
  };

  global.T4TDeck = Deck;
})(window);
