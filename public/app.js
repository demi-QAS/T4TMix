// ============ T4T Mix v0.7 — the tape, the player, send ============
// One shared player (player.js / T4TDeck) drives Spotify, YouTube and previews from OUR buttons.
// Stickers are gone; the tape is personalised with skin, pen colour, paper, title, engraving and a photo.

// ---------- FALLBACK DATA ----------
const FALLBACK_TRACKS = [
  { title: "every day is a game", artist: "Night Tapes" },
  { title: "EAT YOU UP", artist: "russel buck" },
  { title: "Running Away", artist: "VANO 3000, BADBADNOTGOOD, Samuel T. Herring" },
  { title: "Every Time the Sun Comes Up", artist: "Sharon Van Etten" },
  { title: "Feather (feat. Cise Starr & Akin)", artist: "Nujabes, Cise Starr & Akin from CYNE" },
  { title: "Ayye", artist: "Mac Miller" },
  { title: "Anxiety", artist: "Patrice Roberts" },
  { title: "GOT UR NUMB3R - v2", artist: "bugcried" },
  { title: "So Good at Being in Trouble", artist: "Unknown Mortal Orchestra" },
  { title: "I Wanna Be With You", artist: "Saúl David, GUMI" }
];
const FALLBACK_PLAYLIST_TITLE = "Jack O'Lantern - Goodbye Playlist ✈️🌍 💕";
// v0.6: the API lives in the SAME Worker that serves this page, so calls are
// same-origin ("/api/..."). Only set this if you ever host the front-end elsewhere.
const API_BASE = (window.T4T_API_BASE || "").replace(/\/$/, "");
const LS_SENT = "t4tmix.sent.v1";       // [{ id, url, ownerToken, title, at }]
const LS_PHOTOS = "t4tmix.photos.v1";   // photos kept separate so a big photo can't wipe the rest of your tape
// Voice memos live in memory as Blobs until Send (blob: URLs die on reload anyway).
const memoBlobs = new Map();            // trackIndex -> Blob

const SKIN_GRADIENTS = {
  trans:  { shell:"linear-gradient(160deg,#e8e0d6,#d8cabf)", label:"#fbf6ea", tag:"#3a8fc7", spine:"linear-gradient(180deg,#5BCEFA,#F5A9B8)", shellPlayer:"linear-gradient(160deg,#5BCEFA,#F5A9B8)", shellFlat:"#5BCEFA", qr:"#5BCEFA" },
  lesbian:{ shell:"linear-gradient(160deg,#f0ddd2,#e0bfae)", label:"#fff3ec", tag:"#a83a1f", spine:"linear-gradient(180deg,#D62900,#D462A6)", shellPlayer:"linear-gradient(160deg,#D62900,#FF9B55,#D462A6)", shellFlat:"#D62900", qr:"#D462A6" },
  bi:     { shell:"linear-gradient(160deg,#ecdcec,#d8bfe0)", label:"#fdf3fb", tag:"#8a3a8a", spine:"linear-gradient(180deg,#D60270,#0038A8)", shellPlayer:"linear-gradient(160deg,#D60270,#9B4F96,#0038A8)", shellFlat:"#9B4F96", qr:"#9B4F96" },
  nb:     { shell:"linear-gradient(160deg,#eeeadc,#d9cfe0)", label:"#fdfbe8", tag:"#7a5aa8", spine:"linear-gradient(180deg,#FCF434,#9C59D1)", shellPlayer:"linear-gradient(160deg,#FCF434,#9C59D1,#2C2C2C)", shellFlat:"#9C59D1", qr:"#9C59D1" },
  pride:  { shell:"linear-gradient(160deg,#ede4d4,#d6c9e0)", label:"#fdf8ea", tag:"#4a2e6a", spine:"linear-gradient(180deg,#E70000,#0044FF)", shellPlayer:"linear-gradient(160deg,#E70000,#FF8C00,#FFEF00,#00811F,#0044FF,#760089)", shellFlat:"#760089", qr:"#760089" }
};

const STORAGE_KEY = "t4tmix.state.v7";

// ---------- STATE ----------
// Every track carries { display, original } — display is what the recipient sees; original stays
// in the credits (surfaced on the now-playing card as a subtle "originally: …" line).
const state = {
  source: "spotify", playlistUrl: "", playlistId: "", playlistTitle: "",
  tapeTitle: "a mix for you", engraving: "", skin: "trans",
  tracks: [], coverPhoto: null, ink: "midnight", paper: "cream",
  letterText: "",
  shellShape: "boombox",
  activeTrackIndex: null, mediaRecorder: null, recordedChunks: [], recordTimerInterval: null,
  isPlaying: false, mixtapesSentThisMonth: 1,
  currentTrackIndex: 0, playbackTimer: null,
  ytPlaylistId: ""
};

// ---------- HELPERS ----------
function escapeHtml(str){ return String(str||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function el(id){ return document.getElementById(id); }
function qs(sel, root){ return (root||document).querySelector(sel); }
function qsa(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
function extractSpotifyId(url){ const m = url.match(/playlist[\/:]([a-zA-Z0-9]+)/); return m ? m[1] : null; }
function extractYouTubeListId(url){ const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/); return m ? m[1] : null; }
function extractYouTubeVideoId(url){ const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/); return m ? m[1] : null; }

// ---------- PERSISTENCE ----------
function saveState(){
  try {
    const clean = { ...state };
    // strip runtime handles that can't be JSON'd
    delete clean.mediaRecorder; delete clean.recordedChunks;
    delete clean.playbackTimer; delete clean.recordTimerInterval;
    delete clean.coverPhoto; delete clean.isPlaying;
    clean.tracks = (clean.tracks || []).map(t => ({ ...t, voiceMemoUrl: null }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch(e){ /* private mode etc. */ }
  try {
    localStorage.setItem(LS_PHOTOS, JSON.stringify({
      coverPhoto: state.coverPhoto
    }));
  } catch(e){ /* photo too big for storage — it still works this session */ }
}
function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state, saved);
    state.isPlaying = false;
    (state.tracks || []).forEach(t => { t.voiceMemoUrl = null; }); // old blob: links are dead after reload
  } catch(e){}
  try { Object.assign(state, JSON.parse(localStorage.getItem(LS_PHOTOS) || "{}")); } catch(e){}
}

// ---------- SCREEN NAV ----------
function showScreen(id){
  qsa(".screen").forEach(s => s.classList.remove("active"));
  el(id).classList.add("active");
  const stepInd = el("step-indicator");
  if (id === "screen-hero"){ stepInd.style.display = "none"; }
  else {
    stepInd.style.display = "flex";
    const map = { "screen-tape":"tape", "screen-player":"player", "screen-send":"send" };
    const current = map[id]; let seen = true;
    qsa(".step-dot").forEach(dot => {
      const step = dot.dataset.step; dot.classList.remove("active","done");
      if (step === current){ dot.classList.add("active"); seen = false; }
      else if (seen){ dot.classList.add("done"); }
    });
  }
  window.scrollTo({top:0, behavior:"smooth"});
  if (id !== "screen-player" && deck) deck.pause();
}

// ---------- LOAD PLAYLIST ----------
async function loadPlaylist(){
  const spotifyUrl = el("spotify-input").value.trim();
  const ytmUrl = el("ytm-input").value.trim();
  const statusEl = el("load-status");
  statusEl.textContent = "loading your playlist…";

  if (ytmUrl){
    state.source = "youtube";
    const listId = extractYouTubeListId(ytmUrl);
    state.ytPlaylistId = listId || "";
    state.playlistUrl = ytmUrl; state.playlistId = listId || "";
    state.playlistTitle = "your YouTube mix";
    let ok = false;
    try {
      const resp = await fetch(`${API_BASE}/api/playlist?url=${encodeURIComponent(ytmUrl)}`);
      const data = await resp.json();
      if (resp.ok && data.tracks && data.tracks.length){
        state.playlistTitle = data.title || state.playlistTitle;
        state.tracks = data.tracks.map(t => ({ display:t.title, original:t.title, artist:t.artist, note:"", voiceMemoUrl:null, memoPosition:"intro", ytVideoId:t.ytVideoId || null }));
        ok = true;
      }
    } catch(e){ /* fall through */ }
    if (!ok){
      state.tracks = FALLBACK_TRACKS.map(t => ({ display:t.title, original:t.title, artist:t.artist, note:"", voiceMemoUrl:null, memoPosition:"intro" }));
      statusEl.textContent = "YouTube playlist loaded ✓ — song names are samples until the YouTube key is set, but the real songs play.";
    } else {
      statusEl.textContent = `YouTube playlist loaded ✓ ${state.tracks.length} songs`;
    }
  } else if (spotifyUrl){
    state.source = "spotify";
    const id = extractSpotifyId(spotifyUrl);
    state.playlistUrl = spotifyUrl; state.playlistId = id || "";
    if (id){
      try {
        statusEl.textContent = "reading your Spotify playlist…";
        const resp = await fetch(`${API_BASE}/api/playlist?url=${encodeURIComponent(spotifyUrl)}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error || !(data.tracks || []).length) throw new Error(data.error || "worker not ready");
        state.playlistTitle = data.title || data.name || FALLBACK_PLAYLIST_TITLE;
        state.tracks = (data.tracks || []).map(t => ({
          display: t.title, original: t.title, artist: t.artist,
          note: "", voiceMemoUrl: null, memoPosition: "intro",
          ytVideoId: t.ytVideoId || null, spotifyId: t.spotifyId || null,
          previewUrl: t.previewUrl || t.preview_url || null
        }));
        statusEl.textContent = `loaded ✓ ${state.tracks.length} songs`;
      } catch(e){
        useFallbackTracks(statusEl);
        statusEl.textContent = "couldn't read that playlist (is it public?) — using sample songs so you can still play.";
      }
    } else { useFallbackTracks(statusEl); }
  } else {
    statusEl.textContent = "paste a playlist link first 👀";
    return;
  }

  memoBlobs.clear();
  if (deck){ deck.destroy(); deck = null; }
  el("handwritten-title").textContent = state.tapeTitle;
  buildTapeScreen();
  showScreen("screen-tape");
  saveState();
}
function useFallbackTracks(statusEl){
  state.playlistTitle = FALLBACK_PLAYLIST_TITLE;
  state.tracks = FALLBACK_TRACKS.map(t => ({ display:t.title, original:t.title, artist:t.artist, note:"", voiceMemoUrl:null, memoPosition:"intro" }));
  statusEl.textContent = "loaded ✓ (sample songs)";
}

// ---------- TAPE SCREEN ----------
function buildTapeScreen(){
  el("playlist-title-display").textContent = state.playlistTitle;
  renderBackTracklist();
  applySkin(state.skin); applyInk(state.ink); applyPaper(state.paper);
  updateLetterTabState();
  const eng = el("cassette-engraving");
  if (state.engraving){ eng.textContent = state.engraving; eng.classList.add("has-value"); }
  const slot = el("cassette-photo-slot");
  if (state.coverPhoto){ slot.style.backgroundImage = `url(${state.coverPhoto})`; slot.classList.add("has-photo"); }
}

// ---------- THE J-CARD (every song, full width) ----------
function renderBackTracklist(){
  const wrap = el("back-tracklist");
  wrap.innerHTML = "";
  const now = deck ? deck.state.index : -1;
  state.tracks.forEach((t, i) => {
    const li = document.createElement("li");
    const renamed = t.display && t.display !== t.original;
    const icon = t.voiceMemoUrl ? "🎙️" : (t.note ? "📝" : "＋");
    li.innerHTML = `<button class="jsong${i === now ? " now" : ""}" data-i="${i}">
      <span class="num">${String(i+1).padStart(2,"0")}</span>
      <span class="meta"><span class="t">${escapeHtml(t.display)}</span>
      <span class="a">${escapeHtml(renamed ? `${t.original} · ${t.artist || ""}` : (t.artist || ""))}</span>
      ${t.note ? `<span class="n">“${escapeHtml(t.note)}”</span>` : ""}</span>
      <span class="add${(t.voiceMemoUrl || t.note) ? " has" : ""}" aria-hidden="true">${icon}</span></button>`;
    li.querySelector("button").addEventListener("click", () => openVoiceModal(i));
    wrap.appendChild(li);
  });
}

function applySkin(skinKey){
  state.skin = skinKey;
  const g = SKIN_GRADIENTS[skinKey];
  const root = document.documentElement.style;
  root.setProperty("--tape-shell", g.shell);
  root.setProperty("--label-paper", g.label);
  root.setProperty("--shell-bg", g.shellPlayer);
  root.setProperty("--shell-bg-flat", g.shellFlat);
  root.setProperty("--qr-border", g.qr);
  qsa(".label-side-tag").forEach(t => t.style.color = g.tag);
  qsa(".skin-swatch").forEach(sw => sw.classList.toggle("active", sw.dataset.skin === skinKey));
  document.documentElement.dataset.skin = skinKey;
  saveState();
}
function applyInk(ink){
  state.ink = ink || "midnight";
  document.documentElement.dataset.ink = state.ink;
  qsa(".ink-dot").forEach(d => d.classList.toggle("active", d.dataset.ink === state.ink));
  saveState();
}
function applyPaper(paper){
  state.paper = paper || "cream";
  document.documentElement.dataset.paper = state.paper;
  qsa(".paper-chip").forEach(d => d.classList.toggle("active", d.dataset.paper === state.paper));
  saveState();
}

// ---------- PHOTO UPLOADS ----------
function setupPhotoUpload(inputId, callback){
  const inp = el(inputId); if (!inp) return;
  inp.addEventListener("change", (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => callback(reader.result);
    reader.readAsDataURL(file);
  });
}

// ---------- LETTER MODAL ----------
function openLetterModal(){
  el("letter-textarea").value = state.letterText;
  el("letter-modal").classList.add("active");
}
function closeLetterModal(){ el("letter-modal").classList.remove("active"); }
function saveLetter(){
  state.letterText = el("letter-textarea").value.trim();
  closeLetterModal(); updateLetterTabState(); saveState();
}
function updateLetterTabState(){
  const tab = el("btn-open-letter");
  if (state.letterText){
    tab.textContent = "💌 your letter is tucked in — tap to edit";
    tab.classList.add("has-letter");
  } else {
    tab.textContent = "💌 tell them how you really feel →";
    tab.classList.remove("has-letter");
  }
}

// ---------- VOICE MEMO MODAL ----------
function openVoiceModal(idx){
  state.activeTrackIndex = idx;
  const t = state.tracks[idx];
  el("voice-track-name").textContent = t.display;
  el("voice-track-artist").textContent = t.artist;
  el("track-rename-input").value = (t.display && t.display !== t.original) ? t.display : "";
  el("track-note-text").value = t.note || "";
  el("memo-position").value = t.memoPosition || "intro";
  const playback = el("voice-playback");
  if (t.voiceMemoUrl){ playback.src = t.voiceMemoUrl; playback.style.display = "block"; }
  else { playback.style.display = "none"; playback.src = ""; }
  el("record-timer").textContent = "0:00";
  el("voice-modal").classList.add("active");
}
function closeVoiceModal(){ el("voice-modal").classList.remove("active"); stopRecordingIfActive(); }
function saveVoice(){
  if (state.activeTrackIndex !== null){
    const t = state.tracks[state.activeTrackIndex];
    t.note = el("track-note-text").value.trim();
    const newName = el("track-rename-input").value.trim();
    if (newName) t.display = newName; else t.display = t.original;
    t.memoPosition = el("memo-position").value;
  }
  closeVoiceModal(); renderBackTracklist(); if (deck) syncDeckTracks(); saveState();
}

let recordStartTime = null;
async function toggleRecording(){
  const btn = el("btn-record");
  if (state.mediaRecorder && state.mediaRecorder.state === "recording"){ stopRecordingIfActive(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    state.recordedChunks = [];
    const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) ? "audio/webm;codecs=opus"
               : (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/mp4")) ? "audio/mp4" : "";
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    state.mediaRecorder = mr;
    mr.ondataavailable = (e) => state.recordedChunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: (mr.mimeType || mime || "audio/webm").split(";")[0] });
      const url = URL.createObjectURL(blob);
      if (state.activeTrackIndex !== null){
        state.tracks[state.activeTrackIndex].voiceMemoUrl = url;
        memoBlobs.set(state.activeTrackIndex, blob);
      }
      const playback = el("voice-playback");
      playback.src = url; playback.style.display = "block";
      stream.getTracks().forEach(tr => tr.stop());
      clearInterval(state.recordTimerInterval);
      btn.classList.remove("recording"); btn.textContent = "🎙️ record";
    };
    mr.start();
    btn.classList.add("recording"); btn.textContent = "⏹ stop";
    recordStartTime = Date.now();
    state.recordTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - recordStartTime)/1000);
      el("record-timer").textContent = `0:${secs.toString().padStart(2,"0")}`;
      if (secs >= 20){ stopRecordingIfActive(); }
    }, 250);
  } catch(err){ el("record-timer").textContent = "mic access denied 🚫"; }
}
function stopRecordingIfActive(){
  if (state.mediaRecorder && state.mediaRecorder.state === "recording"){ state.mediaRecorder.stop(); }
}

// ---------- CLOSING TRANSITION → PLAYER ----------
function playClosingTransitionThenGoToPlayer(){
  const overlay = el("closing-overlay"); overlay.classList.add("active");
  setTimeout(() => {
    overlay.classList.remove("active");
    buildPlayerScreen(); showScreen("screen-player");
  }, 1150);
}

// ---------- PLAYER SCREEN (the same player they'll get) ----------
let deck = null;
function buildPlayerScreen(){
  selectShell(state.shellShape);
  if (!deck) startDeck(); else syncDeckTracks();
}
function deckTracks(){
  return state.tracks.map(t => ({ ...t, memoUrl: t.voiceMemoUrl || null }));
}
function syncDeckTracks(){
  if (!deck) return;
  deck.tracks.forEach((dt, i) => { const t = state.tracks[i]; if (t) Object.assign(dt, { display: t.display, note: t.note, memoPosition: t.memoPosition, memoUrl: t.voiceMemoUrl || null }); });
  deck.emit();
}
const LANE_NAMES = { spotify: "Spotify", youtube: "YouTube", preview: "previews" };
function startDeck(){
  deck = new window.T4TDeck({ mount: el("deck-mount"), tracks: deckTracks(), source: state.source, apiBase: API_BASE, onChange: renderDeck });
  const sw = el("lane-switch");
  sw.innerHTML = deck.lanes.length > 1 ? deck.lanes.map(l => `<button data-lane="${l}">${LANE_NAMES[l]}</button>`).join("") : "";
  qsa("button", sw).forEach(b => b.addEventListener("click", () => { deck.setLane(b.dataset.lane); deck.slot(b.dataset.lane); }));
  if (deck.state.lane) deck.slot(deck.state.lane);
  renderDeck({ ...deck.state, track: deck.current() });
}
function renderDeck(s){
  const t = s.track;
  state.isPlaying = !!s.playing;
  state.currentTrackIndex = s.index;
  const playing = !!s.playing;
  const btn = el("btn-play"); if (btn) btn.textContent = s.loading ? "…" : (playing ? "❚❚" : "▶");
  const prev = el("btn-preview-play"); if (prev) prev.textContent = playing ? "❚❚ pause" : "▶ listen";
  qsa(".shell-art-overlay-reel, #reel-left, #reel-right").forEach(r => r.classList.toggle("spinning", playing));
  const eq = el("eq-bars"); if (eq) eq.classList.toggle("playing", playing);
  if (el("np-track")) el("np-track").textContent = s.memo ? "🎙️ your voice memo…" : (t ? t.display : "—");
  if (el("np-artist")) el("np-artist").textContent = t ? (t.artist || "") : "";
  if (el("deck-msg")){ el("deck-msg").textContent = s.message || ""; el("deck-msg").classList.toggle("nudge", !!s.needsTap); }
  qsa("#lane-switch button").forEach(b => b.classList.toggle("on", b.dataset.lane === s.lane));
  qsa("#back-tracklist .jsong").forEach((b, i) => b.classList.toggle("now", i === s.index && playing));
}

function shellInnerMarkup(shape){
  const shapeKey = (shape === "boombox" || shape === "carabiner") ? shape : "heart";
  const titleText = escapeHtml(state.tapeTitle);
  return `
      <div class="shell-art-stage">
        <img class="shell-art-img" src="assets/full_recorder_${shapeKey}.svg" alt="${shapeKey} tape player" draggable="false">
        <div class="shell-art-overlay-title" id="shell-art-overlay-title">${titleText}</div>
        <div class="shell-art-overlay-reel left"><div class="reel-spokes"></div></div>
        <div class="shell-art-overlay-reel right"><div class="reel-spokes"></div></div>
      </div>
      <div class="eq-bars" id="eq-bars"><span></span><span></span><span></span><span></span><span></span></div>`;
}
function selectShell(shape){
  state.shellShape = shape;
  qsa(".shell-option").forEach(o => o.classList.toggle("active", o.dataset.shell === shape));
  const shell = el("player-shell");
  shell.className = "player-shell shell-" + shape;
  shell.innerHTML = shellInnerMarkup(shape);
  if (deck) renderDeck({ ...deck.state, track: deck.current() });
  saveState();
}

// ---------- SEND SCREEN / QR ----------
// Send saves the whole tape (memos, photo, letter, style) to
// the Worker and the QR opens YOUR recipient page — not the source playlist.
let currentSend = null; // { id, url, embedUrl, ownerToken }

function dataUrlToBlob(dataUrl){
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const [head, b64] = dataUrl.split(",");
  const type = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const bin = atob(b64); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}
// Shrink photos before upload so phones don't send 6 MB camera shots.
async function shrinkImage(dataUrl, maxSide = 1200){
  const blob = dataUrlToBlob(dataUrl); if (!blob) return null;
  try {
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || blob), "image/jpeg", 0.85));
  } catch(e){ return blob; }
}
function buildTapePayload(){
  return {
    senderName: (el("sender-name")?.value || "").trim(),
    recipientName: (el("recipient-name")?.value || "").trim(),
    senderEmail: (el("sender-email")?.value || "").trim(),
    tapeTitle: state.tapeTitle, engraving: state.engraving, letter: state.letterText,
    playlist: state.playlistId ? { source: state.source, id: state.playlistId, title: state.playlistTitle } : null,
    tracks: state.tracks.map(t => ({
      original: t.original, display: t.display, artist: t.artist, note: t.note,
      memoPosition: t.memoPosition, ytVideoId: t.ytVideoId || null,
      spotifyId: t.spotifyId || null, previewUrl: t.previewUrl || null
    })),
    skin: state.skin, ink: state.ink, paper: state.paper, shell: state.shellShape,
    scene: el("scene-picker")?.value || "desk"
  };
}
function renderQR(text){
  const holder = el("qr-canvas-holder"); holder.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(holder, { text, width:220, height:220, colorDark:"#2b2036", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.M });
}
function setSendState(mode, msg){
  const card = el("qr-card"); const status = el("send-status");
  card.classList.toggle("is-ready", mode === "ready");
  el("send-form").style.display = mode === "ready" ? "none" : "block";
  el("send-done").style.display = mode === "ready" ? "block" : "none";
  if (status) status.textContent = msg || "";
}
function buildSendScreen(){
  el("qr-caption").textContent = state.tapeTitle;
  try {
    const me = JSON.parse(localStorage.getItem("t4tmix.me.v1") || "{}");
    if (me.name && el("sender-name") && !el("sender-name").value) el("sender-name").value = me.name;
    if (me.email && el("sender-email") && !el("sender-email").value) el("sender-email").value = me.email;
  } catch(e){}
  if (currentSend){ renderQR(currentSend.url); setSendState("ready"); }
  else { el("qr-canvas-holder").innerHTML = '<div class="qr-placeholder">📼<br>your QR shows up here</div>'; setSendState("form"); }
  renderSentList();
}
async function sendTape(){
  const btn = el("btn-send-tape"); const label = btn.textContent;
  btn.disabled = true; btn.textContent = "wrapping it up…";
  setSendState("form", "");
  try {
    const tape = buildTapePayload();
    localStorage.setItem("t4tmix.me.v1", JSON.stringify({ name: tape.senderName, email: tape.senderEmail }));
    const fd = new FormData();
    fd.append("tape", JSON.stringify(tape));
    memoBlobs.forEach((blob, i) => { if (i < state.tracks.length) fd.append(`memo_${i}`, blob, `memo-${i}`); });
    const photos = [["cover", state.coverPhoto]];
    for (const [field, dataUrl] of photos){
      if (!dataUrl) continue;
      const b = await shrinkImage(dataUrl); if (b) fd.append(field, b, `${field}.jpg`);
    }
    const r = await fetch(`${API_BASE}/api/tape`, { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `couldn't save (${r.status})`);
    currentSend = data;
    const sent = JSON.parse(localStorage.getItem(LS_SENT) || "[]");
    sent.unshift({ id: data.id, url: data.url, ownerToken: data.ownerToken, title: state.tapeTitle, to: tape.recipientName, at: new Date().toISOString() });
    localStorage.setItem(LS_SENT, JSON.stringify(sent.slice(0, 50)));
    renderQR(data.url);
    el("send-link").textContent = data.url; el("send-link").href = data.url;
    setSendState("ready", "");
    renderSentList();
  } catch(e){
    setSendState("form", "😿 " + (e.message || "couldn't send — check your connection and try again"));
  } finally { btn.disabled = false; btn.textContent = label; }
}
function shareTape(){
  if (!currentSend) return;
  const text = `🎧 made you a "${state.tapeTitle}" mixtape — no necklace, just this:`;
  if (navigator.share){ navigator.share({ title: state.tapeTitle, text, url: currentSend.url }).catch(()=>{}); }
  else { copyLink(); }
}
function copyLink(){
  if (!currentSend) return;
  navigator.clipboard.writeText(currentSend.url).then(() => {
    const btn = el("btn-copy"); const original = btn.textContent;
    btn.textContent = "✅ copied!"; setTimeout(() => btn.textContent = original, 1600);
  }).catch(() => { window.prompt("copy this link:", currentSend.url); });
}
// "tapes you've sent" + reply check (replies are private to the sender's device)
async function renderSentList(){
  const box = el("sent-list"); if (!box) return;
  const sent = JSON.parse(localStorage.getItem(LS_SENT) || "[]");
  if (!sent.length){ box.innerHTML = ""; return; }
  box.innerHTML = '<div class="panel-title">📬 tapes you\'ve sent</div>' + sent.slice(0, 8).map((s, i) =>
    `<div class="sent-row" data-i="${i}"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || "a mix")}</a>` +
    `<span class="sent-to">${s.to ? "for " + escapeHtml(s.to) : ""}</span><span class="sent-reply" id="reply-${escapeHtml(s.id)}">…</span></div>`
  ).join("");
  for (const s of sent.slice(0, 8)){
    const slot = el(`reply-${s.id}`); if (!slot) continue;
    try {
      const r = await fetch(`${API_BASE}/api/tape/${s.id}/replies`, { headers: { "x-owner-token": s.ownerToken } });
      const d = await r.json();
      if (!r.ok){ slot.textContent = r.status === 404 ? "expired" : ""; continue; }
      if (!d.reply){ slot.textContent = "no reply yet"; continue; }
      if (d.reply.type === "text"){ slot.textContent = "💌 " + d.reply.text; }
      else {
        slot.innerHTML = "";
        const a = document.createElement("audio"); a.controls = true; a.preload = "none";
        a.src = `${API_BASE}/api/media/${s.id}/${d.reply.audio}?owner=${encodeURIComponent(s.ownerToken)}`;
        slot.append("💌 ", a);
      }
    } catch(e){ slot.textContent = ""; }
  }
}

// ---------- WIRE UP ----------
document.addEventListener("DOMContentLoaded", () => {
  loadState();

  el("btn-load").addEventListener("click", loadPlaylist);

  // Handwritten title
  const titleEl = el("handwritten-title");
  titleEl.addEventListener("input", () => {
    state.tapeTitle = titleEl.textContent.trim() || "a mix for you";
    const shellTitle = el("shell-art-overlay-title");
    if (shellTitle) shellTitle.textContent = state.tapeTitle;
    saveState();
  });
  titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); titleEl.blur(); } });

  // Engraving (spine text above the label)
  const engEl = el("cassette-engraving");
  engEl.addEventListener("focus", () => {
    if (engEl.textContent.trim() === "✎ engrave a message"){ engEl.textContent = ""; }
  });
  engEl.addEventListener("input", () => {
    let v = engEl.textContent;
    if (v.length > 40){ v = v.slice(0, 40); engEl.textContent = v; }
    state.engraving = v.trim();
    engEl.classList.toggle("has-value", !!state.engraving);
    saveState();
  });
  engEl.addEventListener("blur", () => {
    if (!engEl.textContent.trim()){ engEl.textContent = "✎ engrave a message"; engEl.classList.remove("has-value"); }
  });

  qsa(".skin-swatch").forEach(sw => sw.addEventListener("click", () => applySkin(sw.dataset.skin)));
  qsa(".ink-dot").forEach(d => d.addEventListener("click", () => applyInk(d.dataset.ink)));
  qsa(".paper-chip").forEach(d => d.addEventListener("click", () => applyPaper(d.dataset.paper)));

  setupPhotoUpload("cover-photo-input", (dataUrl) => {
    state.coverPhoto = dataUrl;
    const slot = el("cassette-photo-slot");
    slot.style.backgroundImage = `url(${dataUrl})`;
    slot.classList.add("has-photo");
    saveState();
  });
  el("cassette-photo-slot").addEventListener("click", () => el("cover-photo-input").click());

  el("btn-open-letter").addEventListener("click", openLetterModal);
  el("letter-close").addEventListener("click", closeLetterModal);
  el("btn-save-letter").addEventListener("click", saveLetter);

  el("voice-modal-close").addEventListener("click", closeVoiceModal);
  el("btn-record").addEventListener("click", toggleRecording);
  el("btn-save-voice").addEventListener("click", saveVoice);

  el("btn-to-player").addEventListener("click", playClosingTransitionThenGoToPlayer);
  el("btn-back-to-cover").addEventListener("click", () => showScreen("screen-tape"));

  qsa(".shell-option").forEach(o => o.addEventListener("click", () => selectShell(o.dataset.shell)));
  el("btn-play").addEventListener("click", () => { if (!deck) startDeck(); deck.toggle(); });
  el("btn-rewind").addEventListener("click", () => deck && deck.prev());
  el("btn-ff").addEventListener("click", () => deck && deck.next());
  // "listen" on the J-card jumps straight to the player screen and plays
  el("btn-preview-play").addEventListener("click", () => {
    buildPlayerScreen(); showScreen("screen-player");
    if (deck && !deck.state.playing) deck.play();
  });

  el("btn-to-send").addEventListener("click", () => { currentSend = null; buildSendScreen(); showScreen("screen-send"); });
  el("btn-send-tape").addEventListener("click", sendTape);
  el("btn-back-to-player").addEventListener("click", () => showScreen("screen-player"));

  el("btn-share").addEventListener("click", shareTape);
  el("btn-copy").addEventListener("click", copyLink);
});
