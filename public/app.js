// ============ T4T Mix v0.8 — the tape, the player, send, sign-in, feedback ============
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
const LS_PHOTOS = "t4tmix.photos.v1";
const LS_SESSION = "t4tmix.session.v1";
const LS_PASS = "t4tmix.pass.v1";      // access pass from the free-beta access code  // phone sign-in token   // photos kept separate so a big photo can't wipe the rest of your tape
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
  source: "youtube", playlistUrl: "", playlistId: "", playlistTitle: "",
  tapeTitle: "a mix for you", engraving: "", skin: "trans",
  tracks: [], coverPhoto: null, ink: "midnight", paper: "cream",
  letterText: "",
  shellShape: "boombox",
  activeTrackIndex: null, mediaRecorder: null, recordedChunks: [], recordTimerInterval: null,
  isPlaying: false,
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
function isSoundCloudSet(url){ return /^https?:\/\/((www|m)\.)?soundcloud\.com\/[^/]+\/sets\/[^/?#]+|^https?:\/\/on\.soundcloud\.com\//i.test(url); }
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
  const scUrl = (el("sc-input") ? el("sc-input").value : "").trim();
  const statusEl = el("load-status");
  statusEl.textContent = "loading your playlist…";
  const btn = el("btn-load"); btn.disabled = true;
  try { await loadPlaylistInner(spotifyUrl, ytmUrl, scUrl, statusEl); } finally { btn.disabled = false; }
}
async function loadPlaylistInner(spotifyUrl, ytmUrl, scUrl, statusEl){
  if (ytmUrl && !extractYouTubeListId(ytmUrl)){ statusEl.textContent = "that YouTube link needs a playlist in it (…&list=…). open the playlist and copy its link 🙏"; return; }
  if (scUrl && !isSoundCloudSet(scUrl)){ statusEl.textContent = "that SoundCloud link should look like soundcloud.com/artist/sets/playlist-name"; return; }

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
    if (!ok && !appConfig.sampleFallback){ statusEl.textContent = "couldn't read that YouTube playlist — is it public or unlisted?"; return; }
    if (!ok){
      state.tracks = FALLBACK_TRACKS.map(t => ({ display:t.title, original:t.title, artist:t.artist, note:"", voiceMemoUrl:null, memoPosition:"intro" }));
      statusEl.textContent = "YouTube playlist loaded ✓ — song names are samples until the YouTube key is set, but the real songs play.";
    } else {
      statusEl.textContent = `YouTube playlist loaded ✓ ${state.tracks.length} songs`;
    }
  } else if (scUrl){
    state.source = "soundcloud";
    state.playlistUrl = scUrl; state.playlistId = "";
    statusEl.textContent = "reading your SoundCloud playlist…";
    try {
      const resp = await fetch(`${API_BASE}/api/playlist?url=${encodeURIComponent(scUrl)}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !(data.tracks || []).length) throw new Error(data.error || "couldn't read it");
      state.playlistId = data.id || scUrl;
      state.playlistTitle = data.title || "your SoundCloud mix";
      state.tracks = data.tracks.map(t => ({ display:t.title, original:t.title, artist:t.artist, note:"", voiceMemoUrl:null, memoPosition:"intro", scId:t.scId || null, ytVideoId:null }));
      statusEl.textContent = `SoundCloud playlist loaded ✓ ${state.tracks.length} songs`;
    } catch(e){
      statusEl.textContent = (e && e.message) || "couldn't read that SoundCloud playlist — is it public?";
      return;
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
        if (!appConfig.sampleFallback){ statusEl.textContent = "couldn't read that playlist — is it public?"; return; }
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
  else { playback.style.display = "none"; playback.removeAttribute("src"); }
  el("btn-delete-memo").style.display = t.voiceMemoUrl ? "inline-block" : "none";
  el("memo-max").textContent = appConfig.maxMemoSeconds || 20;
  el("record-timer").textContent = "0:00";
  el("voice-modal").classList.add("active");
}
function deleteMemo(){
  const i = state.activeTrackIndex; if (i === null) return;
  const t = state.tracks[i]; if (t.voiceMemoUrl) try { URL.revokeObjectURL(t.voiceMemoUrl); } catch(e){}
  t.voiceMemoUrl = null; memoBlobs.delete(i);
  const pb = el("voice-playback"); pb.pause(); pb.removeAttribute("src"); pb.style.display = "none";
  el("btn-delete-memo").style.display = "none"; el("record-timer").textContent = "0:00";
  renderBackTracklist(); if (deck) syncDeckTracks(); saveState();
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

let recordStartTime = null, micStarting = false;
async function toggleRecording(){
  const btn = el("btn-record");
  if (state.mediaRecorder && state.mediaRecorder.state === "recording"){ stopRecordingIfActive(); return; }
  if (micStarting) return; // double-tap while the mic permission prompt is up
  if (!navigator.mediaDevices || !window.MediaRecorder){ el("record-timer").textContent = "this browser can't record — try Chrome or Safari"; return; }
  micStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } });
    micStarting = false;
    const recIndex = state.activeTrackIndex; // the song this memo belongs to, even if the modal changes
    state.recordedChunks = [];
    const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) ? "audio/webm;codecs=opus"
               : (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/mp4")) ? "audio/mp4" : "";
    const opts = { audioBitsPerSecond: 64000 }; if (mime) opts.mimeType = mime;
    let mr; try { mr = new MediaRecorder(stream, opts); } catch(e){ mr = new MediaRecorder(stream); }
    state.mediaRecorder = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) state.recordedChunks.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: (mr.mimeType || mime || "audio/webm").split(";")[0] });
      stream.getTracks().forEach(tr => tr.stop());
      clearInterval(state.recordTimerInterval);
      btn.classList.remove("recording"); btn.textContent = "🎙️ record";
      if (blob.size < 1200){ el("record-timer").textContent = "that was too short — hold on a sec longer"; return; }
      const url = URL.createObjectURL(blob);
      if (recIndex !== null && state.tracks[recIndex]){
        const old = state.tracks[recIndex].voiceMemoUrl; if (old) try { URL.revokeObjectURL(old); } catch(e){}
        state.tracks[recIndex].voiceMemoUrl = url;
        memoBlobs.set(recIndex, blob);
        renderBackTracklist(); if (deck) syncDeckTracks();
      }
      el("btn-delete-memo").style.display = "inline-block";
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
      if (secs >= (appConfig.maxMemoSeconds || 20)){ stopRecordingIfActive(); }
    }, 250);
  } catch(err){ micStarting = false; el("record-timer").textContent = "mic access denied 🚫 — allow the microphone in your browser settings"; }
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
const LANE_NAMES = { youtube: "YouTube", soundcloud: "SoundCloud", spotify: "Spotify", preview: "previews" };
function startDeck(){
  deck = new window.T4TDeck({ mount: el("deck-mount"), tracks: deckTracks(), source: state.source, apiBase: API_BASE, onChange: renderDeck,
    lanesAllowed: appConfig.lanes, defaultLane: appConfig.defaultLane || "youtube", scSearch: !!appConfig.soundcloudSearch });
  deck.warm();
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
  if (el("np-track")) el("np-track").textContent = s.memo ? (t && t.memoPosition === "over-ad" ? `🎙️ you, over “${t.display}”` : "🎙️ your voice memo…") : (t ? t.display : "—");
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
    tapeTitle: state.tapeTitle, engraving: state.engraving, letter: state.letterText,
    playlist: state.playlistId ? { source: state.source, id: state.playlistId, title: state.playlistTitle } : null,
    tracks: state.tracks.map(t => ({
      original: t.original, display: t.display, artist: t.artist, note: t.note,
      memoPosition: t.memoPosition, ytVideoId: t.ytVideoId || null, scId: t.scId || null,
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
    if (!me.name && session.user && session.user.name && el("sender-name") && !el("sender-name").value) el("sender-name").value = session.user.name;
  } catch(e){}
  if (currentSend){ renderQR(currentSend.url); setSendState("ready"); }
  else { el("qr-canvas-holder").innerHTML = '<div class="qr-placeholder">📼<br>your QR shows up here</div>'; setSendState("form"); }
  el("signin-nudge").hidden = !!session.token || !appConfig.login;
  renderSentList();
}
async function sendTape(){
  if (appConfig.maintenance || appConfig.newTapes === false){ setSendState("form", "😿 " + (appConfig.banner || "sending is paused for a moment — try again soon")); return; }
  const btn = el("btn-send-tape"); const label = btn.textContent;
  btn.disabled = true; btn.textContent = "wrapping it up…";
  setSendState("form", "");
  try {
    const tape = buildTapePayload();
    localStorage.setItem("t4tmix.me.v1", JSON.stringify({ name: tape.senderName }));
    const fd = new FormData();
    fd.append("tape", JSON.stringify(tape));
    memoBlobs.forEach((blob, i) => { if (i < state.tracks.length) fd.append(`memo_${i}`, blob, `memo-${i}`); });
    const photos = [["cover", state.coverPhoto]];
    for (const [field, dataUrl] of photos){
      if (!dataUrl) continue;
      const b = await shrinkImage(dataUrl); if (b) fd.append(field, b, `${field}.jpg`);
    }
    const r = await fetch(`${API_BASE}/api/tape`, { method: "POST", body: fd, headers: authHeaders() });
    const data = await r.json().catch(() => ({}));
    if (r.status === 402 && data.gate){ try { localStorage.removeItem(LS_PASS); } catch(e){} showGate(); throw new Error("enter your access code, then hit send again — your tape is still here"); }
    if (!r.ok || !data.ok) throw new Error(data.error || `couldn't save (${r.status})`);
    currentSend = data;
    const sent = JSON.parse(localStorage.getItem(LS_SENT) || "[]");
    sent.unshift({ id: data.id, url: data.url, ownerToken: data.ownerToken, title: state.tapeTitle, to: tape.recipientName, at: new Date().toISOString() });
    localStorage.setItem(LS_SENT, JSON.stringify(sent.slice(0, 50)));
    renderQR(data.url);
    el("send-link").textContent = data.url; el("send-link").href = data.url;
    const memoCount = memoBlobs.size;
    el("qr-note").textContent = (data.memos < memoCount ? `⚠️ ${memoCount - data.memos} voice memo(s) didn't make it — re-record and send again. ` : "") +
      (data.linkedToAccount ? "saved to your account — we'll text you when they write back 💌" : "they scan it → unwrap your tape → hear the songs + your voice. they can write back once.");
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
// "tapes you've sent" + reply check. Signed in → your account (every device).
// Not signed in → this device only (owner tokens in localStorage).
async function renderSentList(){
  const box = el("sent-list"); if (!box) return;
  if (session.token){
    const me = await refreshMe();
    const tapes = (me && me.tapes) || [];
    if (!tapes.length){ box.innerHTML = ""; return; }
    box.innerHTML = '<div class="panel-title">📬 tapes you\'ve sent</div>' + tapes.slice(0, 8).map(sentRowHtml).join("");
    return;
  }
  const sent = JSON.parse(localStorage.getItem(LS_SENT) || "[]");
  if (!sent.length){ box.innerHTML = ""; return; }
  box.innerHTML = '<div class="panel-title">📬 tapes you\'ve sent <em>(this device)</em></div>' + sent.slice(0, 8).map((s, i) =>
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
      slot.innerHTML = d.reply.link ? `<a class="reply-open" href="${escapeHtml(d.reply.link)}">💌 ${escapeHtml(d.reply.from || "they")} wrote back — open it</a>` : "💌 they wrote back";
    } catch(e){ slot.textContent = ""; }
  }
}
function sentRowHtml(t){
  if (t.gone) return "";
  const reply = t.reply
    ? `<a class="reply-open${t.reply.seen ? "" : " unread"}" href="${escapeHtml(t.reply.link || "#")}">💌 ${escapeHtml(t.reply.from || "they")} wrote back${t.reply.type === "audio" ? " (voice)" : ""}${t.reply.seen ? "" : " · new"}</a>`
    : '<span class="muted">no reply yet</span>';
  return `<div class="sent-row"><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.title || "a mix")}</a>` +
    `<span class="sent-to">${t.to ? "for " + escapeHtml(t.to) : ""}</span><span class="sent-reply">${reply}</span></div>`;
}

// ---------- RUNTIME CONFIG (set from /admin) ----------
let appConfig = { lanes: { youtube:true, soundcloud:true, spotify:true, preview:true }, defaultLane: "youtube", login: false, feedback: true, donationUrl: "", donationLabel: "chip in", sampleFallback: true, maxMemoSeconds: 20 };
async function loadConfig(){
  try {
    const r = await fetch(`${API_BASE}/api/config`);
    if (r.ok) appConfig = Object.assign(appConfig, await r.json());
  } catch(e){}
  const banner = el("site-banner");
  const msg = appConfig.banner || (appConfig.maintenance ? "T4T Mix is getting a quick tune-up — back in a moment 🔧" : "");
  banner.hidden = !msg; banner.textContent = msg;
  ["hero-donate", "send-donate", "fb-donate"].forEach(id => {
    const a = el(id); if (!a) return;
    a.hidden = !appConfig.donationUrl;
    if (appConfig.donationUrl){ a.href = appConfig.donationUrl; if (id !== "fb-donate") a.textContent = "☕ " + (appConfig.donationLabel || "chip in"); }
  });
  qsa("[data-open-feedback]").forEach(b => b.hidden = !appConfig.feedback);
  paintReplyCopy(); paintSupportLinks();
  renderAccountBar();
  await checkAccess();
}


// ---------- ACCESS GATE (free beta cover page) ----------
function accessPass(){ try { return localStorage.getItem(LS_PASS) || ""; } catch(e){ return ""; } }
let gateOpen = false;
function paintGate(){
  const survey = appConfig.surveyUrl || "";
  const sv = el("gate-survey");
  sv.hidden = !survey; sv.href = survey || "#";
  el("gate-survey-link").textContent = survey.replace(/^https?:\/\//, "");
  el("gate-survey-note").textContent = appConfig.gateSurveyNote || "";
  const v = appConfig.venmo || "";
  el("gate-venmo-card").hidden = !v;
  el("gate-venmo-handle").textContent = v ? "@" + v : "";
  el("gate-venmo").href = v ? `https://venmo.com/u/${encodeURIComponent(v)}` : "#";
  el("gate-donate-note").textContent = appConfig.gateDonateNote || "";
  el("gate-signin").hidden = !appConfig.login || !!session.token;
}
function showGate(){
  if (gateOpen){ paintGate(); return; }
  gateOpen = true; paintGate();
  const g = el("gate"); g.classList.remove("opening"); g.hidden = false;
  document.body.classList.add("gated");
  // a code in the link (…/?code=MIX-ABC123) fills itself in
  const pre = new URLSearchParams(location.search).get("code");
  if (pre){ el("gate-code").value = pre; }
}
function hideGate(animate){
  const g = el("gate");
  document.body.classList.remove("gated");
  gateOpen = false; setTimeout(paintReplyToast, animate ? 850 : 0);
  if (!animate){ g.hidden = true; return; }
  g.classList.add("opening");
  setTimeout(() => { g.hidden = true; g.classList.remove("opening"); }, 800);
}
async function checkAccess(){
  if (!appConfig.gate){ hideGate(false); return true; }
  const hasLocal = !!accessPass() || !!(session.user && session.user.access);
  if (!hasLocal){ showGate(); return false; }
  try {
    const r = await fetch(`${API_BASE}/api/access`, { headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.access){ hideGate(false); return true; }
    if (r.ok && !d.access){ try { localStorage.removeItem(LS_PASS); } catch(e){} showGate(); return false; }
  } catch(e){}
  hideGate(false); return true; // offline / server hiccup: don't lock people out — sending still checks
}
async function redeemCode(e){
  if (e) e.preventDefault();
  const input = el("gate-code"), msg = el("gate-msg"), btn = el("gate-go"), tape = el("gate-form");
  const code = input.value.trim();
  msg.classList.remove("ok");
  if (code.replace(/[^A-Za-z0-9]/g, "").length < 4){ msg.textContent = "type the code you got first ✍️"; input.focus(); return; }
  btn.disabled = true; btn.textContent = "checking…"; msg.textContent = ""; tape.classList.add("spinning");
  try {
    const r = await fetch(`${API_BASE}/api/access`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ code }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.pass) throw new Error(d.error || "that code didn't work");
    try { localStorage.setItem(LS_PASS, d.pass); } catch(e){}
    if (session.user) session.user.access = true;
    msg.classList.add("ok"); msg.textContent = "you're in. welcome to the beta 💛";
    btn.textContent = "▶ playing…";
    if (location.search.includes("code=")) history.replaceState(null, "", location.pathname);
    setTimeout(() => { tape.classList.remove("spinning"); hideGate(true); }, 900);
  } catch(err){
    tape.classList.remove("spinning"); tape.classList.remove("shake"); void tape.offsetWidth; tape.classList.add("shake");
    msg.textContent = err.message;
    btn.textContent = "▶ press play";
  } finally { btn.disabled = false; }
}

// ---------- PHONE SIGN-IN ----------
const session = { token: null, user: null, me: null };
try { Object.assign(session, JSON.parse(localStorage.getItem(LS_SESSION) || "{}")); } catch(e){}
function authHeaders(extra){
  const pass = accessPass();
  return Object.assign({}, extra || {}, session.token ? { authorization: `Bearer ${session.token}` } : {}, pass ? { "x-t4t-pass": pass } : {});
}
function saveSession(){ try { localStorage.setItem(LS_SESSION, JSON.stringify({ token: session.token, user: session.user })); } catch(e){} }
function renderAccountBar(){
  el("btn-signin").hidden = !!session.token || !appConfig.login;
  el("btn-inbox").hidden = !session.token;
  const unread = session.me ? session.me.unread : 0;
  el("inbox-badge").hidden = !unread; el("inbox-badge").textContent = unread;
  paintReplyToast();
}
// in-app alert when a reply is waiting (works with or without text alerts)
let toastDismissed = false;
function paintReplyToast(){
  const me = session.me; const t = el("reply-toast"); if (!t) return;
  const fresh = me && session.token ? (me.tapes || []).filter(x => x.reply && !x.reply.seen) : [];
  if (!fresh.length || toastDismissed || gateOpen){ t.hidden = true; return; }
  const who = fresh[0].reply.from || "someone";
  el("reply-toast-text").textContent = fresh.length > 1 ? `${fresh.length} new replies on your tapes!` : `${who} wrote back on "${fresh[0].title || "your tape"}"!`;
  t.hidden = false;
}
function paintReplyCopy(){
  const sms = !!appConfig.smsReplies;
  if (el("warn-reply-how")) el("warn-reply-how").textContent = sms ? "we text you when they write back (no texting back and forth — just a heads-up)" : "it lands in your tapes inbox and we'll flag it the moment you're back";
  if (el("inbox-notify-label")) el("inbox-notify-label").textContent = sms ? "text me when someone writes back" : "text alerts for replies are coming soon — new replies show up here";
  if (el("inbox-notify")) el("inbox-notify").disabled = !sms;
}
function paintSupportLinks(){
  const sv = appConfig.surveyUrl || "", p9 = appConfig.p990Url || "", v = appConfig.venmo || "";
  if (el("land-survey")){ el("land-survey").hidden = !sv; if (sv) el("land-survey").href = sv; }
  if (el("land-p990")){ el("land-p990").hidden = !p9; if (p9) el("land-p990").href = p9; }
  if (el("land-venmo")){ el("land-venmo").hidden = !v; if (v){ el("land-venmo").href = `https://venmo.com/u/${encodeURIComponent(v)}`; el("land-venmo-handle").textContent = "@" + v; } }
}
async function refreshMe(){
  if (!session.token) return null;
  try {
    const r = await fetch(`${API_BASE}/api/me`, { headers: authHeaders() });
    if (r.status === 401){ session.token = null; session.user = null; session.me = null; saveSession(); renderAccountBar(); return null; }
    const d = await r.json(); if (!r.ok) return null;
    session.me = d; session.user = d.user; saveSession(); renderAccountBar();
    return d;
  } catch(e){ return null; }
}
let signinPhone = "";
function openModal(id){ el(id).classList.add("active"); }
function closeModal(node){ (node.closest ? node.closest(".modal-overlay") : node).classList.remove("active"); }
function openSignin(){
  el("signin-step-phone").hidden = false; el("signin-step-code").hidden = true; el("signin-status").textContent = "";
  openModal("signin-modal"); setTimeout(() => el("signin-phone").focus(), 50);
}
async function sendCode(){
  const btn = el("btn-send-code"); const phone = el("signin-phone").value.trim();
  if (phone.replace(/\D/g, "").length < 10){ el("signin-status").textContent = "enter your full number (with area code)"; return; }
  btn.disabled = true; el("signin-status").textContent = "sending…";
  try {
    const r = await fetch(`${API_BASE}/api/auth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "couldn't send a code");
    signinPhone = phone;
    el("signin-sent-to").textContent = `we texted a code to ${d.phone}${d.dev ? " (dev mode — use the DEV_OTP code)" : ""}`;
    el("signin-step-phone").hidden = true; el("signin-step-code").hidden = false; el("signin-status").textContent = "";
    setTimeout(() => el("signin-code").focus(), 50);
  } catch(e){ el("signin-status").textContent = "😿 " + e.message; }
  finally { btn.disabled = false; }
}
async function verifyCode(){
  const btn = el("btn-verify-code"); const code = el("signin-code").value.trim();
  if (code.length < 4) return;
  btn.disabled = true; el("signin-status").textContent = "checking…";
  try {
    const r = await fetch(`${API_BASE}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: signinPhone, code, name: el("signin-name").value.trim() }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "that didn't work");
    session.token = d.token; session.user = d.user; saveSession();
    // move tapes sent from this device (before signing in) into the account
    const local = JSON.parse(localStorage.getItem(LS_SENT) || "[]");
    if (local.length){
      await fetch(`${API_BASE}/api/me/claim`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ tapes: local.map(t => ({ id: t.id, ownerToken: t.ownerToken })) }) }).catch(() => {});
    }
    el("signin-status").textContent = "";
    closeModal(el("signin-modal"));
    await refreshMe(); renderAccountBar();
    if (gateOpen){ const ok = await checkAccess(); if (!ok){ paintGate(); el("gate-msg").classList.remove("ok"); el("gate-msg").textContent = "you're signed in — now enter your code once and it's saved to your account."; } }
    if (el("screen-send").classList.contains("active")) buildSendScreen();
    if (pendingAfterSignin){ const f = pendingAfterSignin; pendingAfterSignin = null; f(); }
  } catch(e){ el("signin-status").textContent = "😿 " + e.message; }
  finally { btn.disabled = false; }
}
let pendingAfterSignin = null;
// gentle reminder: not signed in → explain why signing in helps (once per visit)
function loadWithSigninReminder(){
  let warned = false; try { warned = sessionStorage.getItem("t4tmix.warned.v1") === "1"; } catch(e){}
  const hasLink = ["spotify-input","ytm-input","sc-input"].some(id => el(id) && el(id).value.trim());
  if (hasLink && appConfig.login && !session.token && !warned){ openModal("signin-warn-modal"); return; }
  loadPlaylist();
}
async function openInbox(){
  openModal("inbox-modal");
  el("inbox-list").innerHTML = '<p class="muted">loading…</p>';
  const me = await refreshMe();
  if (!me){ closeModal(el("inbox-modal")); openSignin(); return; }
  el("inbox-who").textContent = `signed in as ${me.user.name ? me.user.name + " · " : ""}${me.user.phone}`;
  el("inbox-notify").checked = me.user.notify !== false;
  el("inbox-list").innerHTML = me.tapes.length ? me.tapes.map(sentRowHtml).join("") : '<p class="muted">no tapes yet — go make one 📼</p>';
}
async function signOut(){
  await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", headers: authHeaders() }).catch(() => {});
  session.token = null; session.user = null; session.me = null; saveSession();
  closeModal(el("inbox-modal")); renderAccountBar();
}

// ---------- FEEDBACK ----------
let fbRating = "";
function openFeedback(){
  el("fb-form").hidden = false; el("fb-done").hidden = true; el("fb-status").textContent = "";
  openModal("feedback-modal");
}
async function sendFeedback(){
  const message = el("fb-message").value.trim();
  if (message.length < 2 && !fbRating){ el("fb-status").textContent = "pick a face or write a little something 🙏"; return; }
  const btn = el("btn-send-feedback"); btn.disabled = true;
  try {
    const r = await fetch(`${API_BASE}/api/feedback`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ message: message || `(${fbRating})`, rating: fbRating, contact: el("fb-contact").value.trim(), website: el("fb-website").value, page: (qs(".screen.active") || {}).id || "" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "couldn't send");
    el("fb-form").hidden = true; el("fb-done").hidden = false; el("fb-message").value = ""; fbRating = "";
    qsa("#fb-rating button").forEach(b => b.classList.remove("on"));
  } catch(e){ el("fb-status").textContent = "😿 " + e.message; }
  finally { btn.disabled = false; }
}

// ---------- WIRE UP ----------
document.addEventListener("DOMContentLoaded", () => {
  loadState();
  // no pass on this device → show the cover right away (no flash of the app); config decides after
  if (!accessPass() && !(session.user && session.user.access)) showGate();
  loadConfig();
  if (session.token) refreshMe();

  // account / sign-in / feedback
  el("btn-signin").addEventListener("click", openSignin);
  el("btn-nudge-signin").addEventListener("click", openSignin);
  el("btn-inbox").addEventListener("click", openInbox);
  el("btn-send-code").addEventListener("click", sendCode);
  el("btn-verify-code").addEventListener("click", verifyCode);
  el("signin-phone").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCode(); });
  el("signin-code").addEventListener("input", (e) => { if (e.target.value.replace(/\D/g, "").length === 6) verifyCode(); });
  el("btn-code-back").addEventListener("click", () => { el("signin-step-phone").hidden = false; el("signin-step-code").hidden = true; });
  el("btn-signout").addEventListener("click", signOut);
  el("inbox-notify").addEventListener("change", (e) => {
    fetch(`${API_BASE}/api/me`, { method: "PATCH", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ notify: e.target.checked }) }).catch(() => {});
  });
  qsa("[data-open-feedback]").forEach(b => b.addEventListener("click", openFeedback));
  qsa("#fb-rating button").forEach(b => b.addEventListener("click", () => {
    fbRating = b.dataset.rating; qsa("#fb-rating button").forEach(x => x.classList.toggle("on", x === b));
  }));
  el("btn-send-feedback").addEventListener("click", sendFeedback);
  qsa("[data-close-modal]").forEach(b => b.addEventListener("click", () => closeModal(b)));
  qsa(".modal-overlay").forEach(m => m.addEventListener("click", (e) => { if (e.target === m && m.id !== "voice-modal") m.classList.remove("active"); }));
  el("btn-delete-memo").addEventListener("click", deleteMemo);

  el("btn-load").addEventListener("click", loadWithSigninReminder);
  el("reply-toast").addEventListener("click", () => { toastDismissed = true; el("reply-toast").hidden = true; openInbox(); });
  // check for new replies when they come back to the tab
  document.addEventListener("visibilitychange", () => { if (!document.hidden && session.token){ toastDismissed = false; refreshMe(); } });
  setInterval(() => { if (!document.hidden && session.token) refreshMe(); }, 90000);
  el("btn-warn-signin").addEventListener("click", () => {
    closeModal(el("signin-warn-modal"));
    pendingAfterSignin = () => loadPlaylist();
    openSignin();
  });
  el("btn-warn-skip").addEventListener("click", () => {
    try { sessionStorage.setItem("t4tmix.warned.v1", "1"); } catch(e){}
    closeModal(el("signin-warn-modal"));
    loadPlaylist();
  });
  el("gate-form").addEventListener("submit", redeemCode);
  el("gate-code").addEventListener("input", () => { el("gate-msg").textContent = ""; });
  el("gate-signin").addEventListener("click", openSignin);
  el("gate-venmo-copy").addEventListener("click", async () => {
    const h = "@" + (appConfig.venmo || "");
    try { await navigator.clipboard.writeText(h); el("gate-venmo-copy").textContent = "copied ✓"; }
    catch(e){ el("gate-venmo-copy").textContent = h; }
    setTimeout(() => { el("gate-venmo-copy").textContent = "copy handle"; }, 1800);
  });

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
