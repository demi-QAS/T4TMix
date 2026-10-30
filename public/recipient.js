/* =========================================================================
   T4T MIX — the gift page (v0.7)
   unwrap → one clean column: the player, our controls, the deck, the songs.
   All playback goes through T4TDeck (player.js), so OUR play button works.
   ========================================================================= */
(function () {
  "use strict";
  const TAPE_ID = window.__TAPE_ID__;
  const IS_EMBED = window.__T4T_EMBED__ === true;
  if (IS_EMBED) document.documentElement.classList.add("is-embed");
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const media = (f) => (f ? `/api/media/${TAPE_ID}/${encodeURIComponent(f)}` : null);
  let tape = null, deck = null;
  let cfg = { lanes: { youtube: true, soundcloud: true, spotify: true, preview: true }, defaultLane: "youtube", replies: true, banner: "", donationUrl: "" };

  const LANE_NAMES = { youtube: "YouTube", soundcloud: "SoundCloud", spotify: "Spotify", preview: "previews" };
  const LANE_FINE = {
    spotify: "full songs if you're logged in to Spotify in this browser — 30-second previews if not.",
    youtube: "full songs, no login. YouTube may play a short ad now and then.",
    soundcloud: "full songs on SoundCloud (when the artist allows it) — no login.",
    preview: "30-second previews — no login needed.",
  };

  async function boot() {
    if (!TAPE_ID || TAPE_ID === "__TAPE_ID__") return;
    try { const c = await fetch("/api/config"); if (c.ok) cfg = Object.assign(cfg, await c.json()); } catch (e) {}
    try {
      const r = await fetch(`/api/tape/${TAPE_ID}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("not found");
      tape = await r.json();
    } catch (e) {
      document.body.innerHTML = '<div class="gone"><p>📼</p><p>this mixtape isn\u2019t here anymore.<br>tapes keep for about six months.</p><a href="/">make your own →</a></div>';
      return;
    }
    dress(tape);
    wireGift();
    wireSheets();
    wireReply();
  }

  /* ---------- dress the page with the sender's choices ---------- */
  function dress(t) {
    const root = document.documentElement;
    root.dataset.skin = t.skin || "trans";
    root.dataset.ink = t.ink || "midnight";
    root.dataset.paper = t.paper || "cream";
    $("giftFrom").textContent = t.senderName ? `${t.senderName} made you something` : "someone made you something";
    $("giftFor").textContent = t.recipientName ? `for ${t.recipientName}` : "for you";
    const title = t.tapeTitle || "a mix for you";
    $("tapeTitle").textContent = title;
    $("shellTitle").textContent = title;
    document.title = `${title} — a T4T Mix`;
    const who = [t.senderName && `from ${t.senderName}`, t.recipientName && `for ${t.recipientName}`].filter(Boolean).join(" · ");
    $("fromTo").textContent = who;

    const shape = ["boombox", "carabiner", "heart"].includes(t.shell) ? t.shell : "boombox";
    $("deckShell").dataset.shell = shape;
    $("shellArt").src = `/assets/full_recorder_${shape}.svg`;

    if (t.coverPhoto) {
      const b = $("coverPhoto");
      b.hidden = false;
      b.style.backgroundImage = `url(${media(t.coverPhoto)})`;
      b.addEventListener("click", () => { $("photoImg").src = media(t.coverPhoto); open("photoSheet"); });
    }
    if (t.letter && t.letter.trim()) {
      $("btnLetter").hidden = false;
      $("letterHead").textContent = t.senderName ? `a note from ${t.senderName}` : "a note for you";
      $("letterBody").textContent = t.letter;
    }
    if (!t.hasReply && cfg.replies !== false) $("btnReply").hidden = false;
    if (cfg.banner) { const b = $("siteBanner"); if (b) { b.hidden = false; b.textContent = cfg.banner; } }
    $("replyToName").textContent = t.senderName || "them";
    renderSongs();
  }

  function renderSongs() {
    const list = $("songList");
    const tracks = tape.tracks || [];
    $("songCount").textContent = tracks.length ? `${tracks.length} song${tracks.length === 1 ? "" : "s"}` : "";
    if (!tracks.length) { list.innerHTML = '<li class="empty">just voice notes on this one</li>'; return; }
    list.innerHTML = tracks.map((tr, i) => {
      const extra = tr.memo ? '<span class="tag">🎙️ memo</span>' : tr.note ? '<span class="tag">📝 note</span>' : "";
      const renamed = tr.original && tr.display && tr.original !== tr.display;
      return `<li><button class="song" data-i="${i}">
        <span class="num">${String(i + 1).padStart(2, "0")}</span>
        <span class="meta"><span class="t">${esc(tr.display || tr.original)}</span>
        <span class="a">${esc(renamed ? `${tr.original} · ${tr.artist || ""}` : tr.artist || "")}</span></span>
        ${extra}<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></button></li>`;
    }).join("");
    list.querySelectorAll(".song").forEach((b) => b.addEventListener("click", () => {
      if (!deck) return;
      const i = Number(b.dataset.i);
      if (i === deck.state.index) deck.toggle(); else deck.jump(i, true);
    }));
  }

  /* ---------- the gift ---------- */
  function wireGift() {
    const gift = $("gift");
    gift.addEventListener("click", () => {
      if (gift.classList.contains("opening")) return;
      gift.classList.add("opening");
      $("giftHint").textContent = "";
      startDeck(); // build the players now, while this tap still counts as a "user gesture"
      setTimeout(() => {
        $("giftStage").classList.add("gone-up");
        $("room").hidden = false;
        requestAnimationFrame(() => $("room").classList.add("in"));
        setTimeout(() => { $("giftStage").hidden = true; }, 900);
        if (tape.letter && tape.letter.trim()) setTimeout(() => open("letterSheet"), 650);
      }, 1500);
    });
    gift.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); gift.click(); } });
  }

  /* ---------- the deck ---------- */
  function startDeck() {
    if (deck) return;
    const tracks = (tape.tracks || []).map((t) => ({ ...t, memoUrl: media(t.memo) }));
    deck = new window.T4TDeck({
      mount: $("deckMount"),
      tracks,
      source: (tape.playlist && tape.playlist.source) || "youtube",
      lanesAllowed: cfg.lanes, defaultLane: cfg.defaultLane || "youtube", scSearch: !!cfg.soundcloudSearch,
      onChange: render,
    });
    renderLanes();
    $("btnPlay").addEventListener("click", () => deck.toggle());
    $("btnNext").addEventListener("click", () => deck.next());
    $("btnPrev").addEventListener("click", () => deck.prev());
    render({ ...deck.state, track: deck.current(), lanes: deck.lanes });
    if (deck.state.lane) deck.slot(deck.state.lane); // show the provider player right away
  }

  function renderLanes() {
    const box = $("laneSwitch");
    if (deck.lanes.length < 2) { box.hidden = true; return; }
    box.innerHTML = deck.lanes.map((l) => `<button role="tab" data-lane="${l}">${LANE_NAMES[l]}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { deck.setLane(b.dataset.lane); deck.slot(b.dataset.lane); }));
  }

  function render(s) {
    const t = s.track;
    const room = $("room");
    room.classList.toggle("is-playing", !!s.playing && !s.memo);
    room.classList.toggle("is-loading", !!s.loading);
    room.classList.toggle("is-memo", !!s.memo);
    $("btnPlay").setAttribute("aria-label", s.playing ? "pause" : "play");
    const who = tape.senderName || "they";
    $("nowKicker").textContent = s.memo ? (t && t.memoPosition === "over-ad" ? `🎙️ ${who}, talking over this one…` : t && t.memoPosition === "outro" ? `🎙️ ${who} has something to add…` : `🎙️ ${who} first…`) : `track ${s.index + 1} of ${(tape.tracks || []).length}`;
    $("nowSong").textContent = t ? (t.display || t.original) : "no songs on this tape";
    $("nowArtist").textContent = t ? (t.artist || "") : "";
    const renamed = t && t.original && t.display && t.original !== t.display;
    $("nowOriginal").hidden = !renamed;
    if (renamed) $("nowOriginal").textContent = `originally “${t.original}”`;
    $("nowNote").hidden = !(t && t.note);
    if (t && t.note) $("nowNote").textContent = `“${t.note}”`;
    $("deckMsg").textContent = s.message || "";
    $("deckMsg").classList.toggle("nudge", !!s.needsTap);
    $("deckFine").textContent = s.lane ? LANE_FINE[s.lane] : "";
    $("laneSwitch").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.lane === s.lane));
    document.querySelectorAll("#songList .song").forEach((b, i) => {
      b.classList.toggle("now", i === s.index);
      b.classList.toggle("live", i === s.index && !!s.playing);
    });
    if (s.needsTap) $("deckMount").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------- sheets ---------- */
  function open(id) { const n = $(id); n.hidden = false; requestAnimationFrame(() => n.classList.add("open")); }
  function close(n) { n.classList.remove("open"); setTimeout(() => { n.hidden = true; }, 250); }
  function wireSheets() {
    document.querySelectorAll(".sheet").forEach((sh) => {
      sh.addEventListener("click", (e) => { if (e.target === sh || e.target.closest("[data-close]")) close(sh); });
    });
    $("btnLetter").addEventListener("click", () => open("letterSheet"));
    $("letterPlay").addEventListener("click", () => { close($("letterSheet")); if (deck && !deck.state.playing) deck.play(); });
    $("btnWhat").addEventListener("click", () => open("whatSheet"));
    $("btnReply").addEventListener("click", () => open("replySheet"));
  }

  /* ---------- reply (one per tape) ---------- */
  let payload = null, rec = null;
  function wireReply() {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === tab));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab.dataset.tab));
    }));
    $("replyText").addEventListener("input", () => {
      const v = $("replyText").value.trim();
      payload = v ? { kind: "text", text: v } : (payload && payload.kind === "voice" ? payload : null);
      $("replySend").disabled = !payload;
    });
    $("recBtn").addEventListener("click", toggleRec);
    $("replySend").addEventListener("click", sendReply);
  }
  async function toggleRec() {
    if (rec && rec.r.state === "recording") { rec.r.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = []; let s = 0;
      r.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      r.onstop = () => {
        clearInterval(rec.iv); stream.getTracks().forEach((x) => x.stop());
        const type = (r.mimeType || mime || "audio/webm").split(";")[0];
        const blob = new Blob(chunks, { type });
        if (blob.size < 1200) { $("recTimer").textContent = "too short — try again"; $("recBtn").classList.remove("on"); $("recBtn").textContent = "●"; return; }
        $("recPlayback").src = URL.createObjectURL(blob); $("recPlayback").hidden = false;
        $("recBtn").classList.remove("on"); $("recBtn").textContent = "●";
        payload = { kind: "voice", blob, type }; $("replySend").disabled = false;
      };
      const max = cfg.maxMemoSeconds || 20;
      rec = { r, iv: setInterval(() => { s++; $("recTimer").textContent = `0:${String(s).padStart(2, "0")} / 0:${max}`; if (s >= max && r.state === "recording") r.stop(); }, 1000) };
      r.start(); $("recBtn").classList.add("on"); $("recBtn").textContent = "■";
    } catch (e) { $("recTimer").textContent = "mic is blocked — try writing instead"; }
  }
  async function sendReply() {
    if (!payload) return;
    const btn = $("replySend"); btn.disabled = true; btn.textContent = "sending…";
    try {
      const fd = new FormData();
      fd.append("kind", payload.kind);
      fd.append("from", $("replyFrom").value.trim());
      if (payload.kind === "voice" && $("replyText").value.trim()) fd.append("text", $("replyText").value.trim());
      if (payload.kind === "text") fd.append("text", payload.text);
      else fd.append("audio", payload.blob, `reply.${payload.type.includes("mp4") ? "mp4" : "webm"}`);
      const r = await fetch(`/api/tape/${TAPE_ID}/reply`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "couldn't send");
      $("replyForm").hidden = true; $("replyDone").hidden = false; $("btnReply").hidden = true;
      $("replyDoneSub").textContent = d.senderNotified
        ? `${tape.senderName || "they"} just got a text — it's on its way 💌`
        : d.inInbox ? `it's waiting in ${tape.senderName || "their"}${tape.senderName ? "'s" : ""} T4T Mix inbox 💌 want to make sure they see it soon? send them this link too 👇`
        : `want to be sure ${tape.senderName || "they"} sees it? send them this link 👇`;
      const link = d.replyUrl;
      $("replyShareRow").hidden = !link;
      $("replyShare").onclick = () => {
        const text = `I wrote back to your mixtape “${tape.tapeTitle || "a mix"}” 💌`;
        if (navigator.share) navigator.share({ title: "I wrote back", text, url: link }).catch(() => {});
        else navigator.clipboard.writeText(link).then(() => { $("replyShare").textContent = "✅ link copied"; }).catch(() => prompt("copy this link:", link));
      };
      $("replyCopy").onclick = () => navigator.clipboard.writeText(link).then(() => { $("replyCopy").textContent = "✅ copied"; }).catch(() => prompt("copy this link:", link));
      $("replySms").href = `sms:?&body=${encodeURIComponent(`I wrote back to your mixtape 💌 ${link}`)}`;
    } catch (e) {
      btn.disabled = false; btn.textContent = "send it";
      $("recTimer").textContent = e.message || "couldn't send — try again";
      alert(e.message || "couldn't send — try again in a moment");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
