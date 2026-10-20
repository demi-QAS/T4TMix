// ============ T4T Mix v4 — the tape IS the canvas ============
// v4 changes (from v3):
//   1. Real YouTube IFrame audio lane (video-search fallback if playlist ID missing)
//   2. Ad-cover cassette-hiss overlay on track transitions (ToS-compliant: we don't touch YT volume)
//   3. Draggable / resizable / removable placed stickers (kept editable after drop)
//   4. Track title edit uses a real <input>, kills the duplicate-line contentEditable bug
//   5. Track renames stored separately from the original ({display, original}); original surfaces on player card
//   6. Sticker state persists across nav (localStorage + rehydrate on show)
//   7. Voice-memo positioning: intro / outro / over-ad
//   8. Engraving field (baked spine text) tracked in state
//   9. Wrap-style adds a "both" mode + separate window-photo upload

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

const STORAGE_KEY = "t4tmix.state.v4";

// ---------- STATE ----------
// Every track carries { display, original } — display is what the recipient sees; original stays
// in the credits (surfaced on the now-playing card as a subtle "originally: …" line).
const state = {
  source: "spotify", playlistUrl: "", playlistId: "", playlistTitle: "",
  tapeTitle: "a mix for you", engraving: "", skin: "trans",
  tracks: [], coverPhoto: null, coverStickers: [],
  letterText: "",
  shellShape: "boombox", shellPhoto: null, shellWindowPhoto: null,
  shellWrapStyle: "fullbody", shellStickers: [],
  activeTrackIndex: null, mediaRecorder: null, recordedChunks: [], recordTimerInterval: null,
  isPlaying: false, mixtapesSentThisMonth: 1,
  currentTrackIndex: 0, playbackTimer: null,
  // YouTube lane
  ytPlayer: null, ytReady: false, ytVideoIds: [], ytPlaylistId: "",
  // Ad-cover
  adCoverActive: false
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
    delete clean.ytPlayer; delete clean.mediaRecorder; delete clean.recordedChunks;
    delete clean.playbackTimer; delete clean.recordTimerInterval;
    delete clean.coverPhoto; delete clean.shellPhoto; delete clean.shellWindowPhoto;
    delete clean.ytReady; delete clean.isPlaying; delete clean.adCoverActive;
    clean.tracks = (clean.tracks || []).map(t => ({ ...t, voiceMemoUrl: null }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch(e){ /* private mode etc. */ }
  try {
    localStorage.setItem(LS_PHOTOS, JSON.stringify({
      coverPhoto: state.coverPhoto, shellPhoto: state.shellPhoto, shellWindowPhoto: state.shellWindowPhoto
    }));
  } catch(e){ /* photo too big for storage — it still works this session */ }
}
function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state, saved);
    state.isPlaying = false; state.ytReady = false;
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
  // rehydrate whichever sticker layer just came into view
  if (id === "screen-tape") rehydrateStickers("front-sticker-layer", state.coverStickers);
  if (id === "screen-player") rehydrateStickers("shell-sticker-layer", state.shellStickers);
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
        state.ytVideoIds = state.tracks.map(t => t.ytVideoId).filter(Boolean);
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
        statusEl.textContent = "resolving Spotify tracks → YouTube (this takes a few seconds for a fresh playlist)…";
        const resp = await fetch(`${API_BASE}/api/bridge?url=${encodeURIComponent(spotifyUrl)}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error || !(data.tracks || []).length) throw new Error(data.error || "worker not ready");
        state.playlistTitle = data.title || data.name || FALLBACK_PLAYLIST_TITLE;
        state.tracks = (data.tracks || []).map(t => ({
          display: t.title, original: t.title, artist: t.artist,
          note: "", voiceMemoUrl: null, memoPosition: "intro",
          ytVideoId: t.ytVideoId || null,
          previewUrl: t.previewUrl || t.preview_url || null
        }));
        state.ytVideoIds = state.tracks.map(t => t.ytVideoId).filter(Boolean);
        const resolved = state.ytVideoIds.length;
        const total = state.tracks.length;
        statusEl.textContent = data.bridged
          ? `loaded ✓ ${resolved}/${total} songs found on YouTube` + (resolved < total ? " (the rest play through Spotify)" : "")
          : `loaded ✓ ${total} songs — they'll play through Spotify`;
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
  // hidden Spotify embed kept for legacy fallback, but not the audio source anymore
  const embedWrap = el("source-embed-wrap");
  embedWrap.innerHTML = "";
  if (state.source === "spotify" && state.playlistId){
    const iframe = document.createElement("iframe");
    iframe.src = `https://open.spotify.com/embed/playlist/${state.playlistId}`;
    iframe.width = "1"; iframe.height = "1"; iframe.frameBorder = "0";
    iframe.style.border = "0";
    iframe.title = "Spotify playlist";
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.loading = "lazy";
    embedWrap.appendChild(iframe);
  }
  renderBackTracklist();
  applySkin(state.skin);
  updateLetterTabState();
  // engraving
  const eng = el("cassette-engraving");
  if (state.engraving){ eng.textContent = state.engraving; eng.classList.add("has-value"); }
  rehydrateStickers("front-sticker-layer", state.coverStickers);
}

// ---------- BACK TRACKLIST (Side B) ----------
// v5 fix (Patch A): the whole row taps into the voice/note modal (which owns
// rename + note + memo + record). No inline input — that was eating the tap
// on mobile and hiding the modal behind a tiny ✏️ icon.
function renderBackTracklist(){
  const wrap = el("back-tracklist");
  wrap.innerHTML = "";
  state.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    const isNowPlaying = state.isPlaying && i === state.currentTrackIndex;
    row.className = "btk-row" + (isNowPlaying ? " now-playing" : "");
    const hasMemo = !!(t.voiceMemoUrl || t.note);
    const icon = t.voiceMemoUrl ? "🎙️" : (t.note ? "📝" : "＋");
    const renamed = t.display && t.display !== t.original;
    row.innerHTML = `
      <div class="btk-row-main">
        <span class="btk-num">${i+1}.</span>
        <span class="btk-title">${escapeHtml(t.display)}</span>
        <span class="btk-artist"> — ${escapeHtml(t.artist)}</span>
        <span class="btk-memo-dot ${hasMemo ? 'has-memo' : ''}" title="add a note or voice memo">${icon}</span>
      </div>
      ${renamed ? `<div class="btk-original-preview">originally: ${escapeHtml(t.original)}</div>` : ""}
      ${t.note ? `<div class="btk-note-preview">📝 &ldquo;${escapeHtml(t.note)}&rdquo;</div>` : ""}
    `;
    // Whole row → modal (mobile-friendly hit target)
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openVoiceModal(i);
    });
    wrap.appendChild(row);
    if (isNowPlaying){ row.scrollIntoView({ block:"nearest", behavior:"smooth" }); }
  });
  // v5 fix (Patch B belt-and-suspenders): arm the scroll surface after each
  // render so iOS Safari doesn't drop touch-scroll inside the 3D-transformed
  // parent. Idempotent — safe to call every render.
  armBackScroll();
}

// v5 scroll unlock — some iOS Safari versions need an explicit touchstart to
// arm the scroll surface inside a 3D-transformed parent. Called from
// renderBackTracklist() so it re-arms after every re-render.
function armBackScroll(){
  const wrap = el("back-label") || document.querySelector(".back-label");
  if (!wrap || wrap.__armed) return;
  wrap.__armed = true;
  wrap.addEventListener("touchstart", () => {}, { passive: true });
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
  saveState();
}

// ---------- CASSETTE FLIP ----------
function flipCassette(toBack){
  el("cassette-flipper").classList.toggle("flipped", toBack);
}

// ---------- STICKERS (drag / drop / move / resize / remove) ----------
// v3 bug fixes:
//   - placed stickers are now MOVABLE after drop (pointerdown/move/up on the sticker itself)
//   - a corner handle resizes them
//   - double-tap removes (single-tap no longer nukes them)
//   - state.coverStickers / state.shellStickers are the source of truth and rehydrate on nav
function setupStickerDragDrop(trayId, targetLayerId, storeArray){
  const tray = el(trayId); if (!tray) return;
  qsa(".sticker-item", tray).forEach(item => {
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ emoji: item.dataset.emoji, html: item.innerHTML }));
    });
    // click-to-place also honored, but now the placed sticker is editable (not committed the moment it's placed)
    item.addEventListener("click", () => {
      const x = 15 + Math.random()*55, y = 10 + Math.random()*45;
      addStickerToLayer(targetLayerId, storeArray, item.dataset.emoji, item.innerHTML, x, y, 44);
    });
  });
  const layer = el(targetLayerId); if (!layer) return;
  layer.addEventListener("dragover", (e) => e.preventDefault());
  layer.addEventListener("drop", (e) => {
    e.preventDefault();
    let payload; try { payload = JSON.parse(e.dataTransfer.getData("text/plain")); } catch(_) { payload = { emoji: e.dataTransfer.getData("text/plain"), html: null }; }
    if (!payload || !payload.emoji) return;
    const rect = layer.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    addStickerToLayer(targetLayerId, storeArray, payload.emoji, payload.html, x, y, 44);
  });
}

function addStickerToLayer(layerId, storeArray, emoji, innerHtml, xPct, yPct, sizePx){
  const layer = el(layerId); if (!layer) return;
  const record = { emoji, html: innerHtml || emoji, x: xPct, y: yPct, size: sizePx || 44, rotation: 0 };
  storeArray.push(record);
  renderOneSticker(layer, storeArray, record);
  saveState();
}

function renderOneSticker(layer, storeArray, record){
  const s = document.createElement("div");
  s.className = "placed-sticker";
  s.innerHTML = record.html || record.emoji;
  s.style.left = record.x + "%";
  s.style.top = record.y + "%";
  s.style.width = record.size + "px";
  s.style.height = record.size + "px";
  s.style.transform = `translate(-50%,-50%) rotate(${record.rotation||0}deg)`;
  // resize handle (bottom-right)
  const handle = document.createElement("div");
  handle.className = "sticker-handle";
  s.appendChild(handle);

  // DRAG
  let dragging = false, startX=0, startY=0, startLeft=0, startTop=0;
  s.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return; // handled below
    e.stopPropagation();
    dragging = true;
    s.setPointerCapture(e.pointerId);
    const rect = layer.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = record.x; startTop = record.y;
    s.classList.add("selected");
  });
  s.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = layer.getBoundingClientRect();
    const dx = ((e.clientX - startX) / rect.width) * 100;
    const dy = ((e.clientY - startY) / rect.height) * 100;
    record.x = Math.max(0, Math.min(100, startLeft + dx));
    record.y = Math.max(0, Math.min(100, startTop + dy));
    s.style.left = record.x + "%"; s.style.top = record.y + "%";
  });
  s.addEventListener("pointerup", (e) => { dragging = false; saveState(); });

  // RESIZE
  let resizing = false, rStartX=0, rStartSize=0;
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); resizing = true; handle.setPointerCapture(e.pointerId);
    rStartX = e.clientX; rStartSize = record.size;
  });
  handle.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const delta = e.clientX - rStartX;
    record.size = Math.max(20, Math.min(160, rStartSize + delta));
    s.style.width = record.size + "px"; s.style.height = record.size + "px";
  });
  handle.addEventListener("pointerup", () => { resizing = false; saveState(); });

  // DOUBLE-TAP = remove (single-tap no longer removes; that was the v3 UX bug)
  let lastTap = 0;
  s.addEventListener("click", (e) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 350){
      const idx = storeArray.indexOf(record);
      if (idx >= 0) storeArray.splice(idx, 1);
      s.remove();
      saveState();
    }
    lastTap = now;
  });

  layer.appendChild(s);
}

function rehydrateStickers(layerId, storeArray){
  const layer = el(layerId); if (!layer) return;
  layer.innerHTML = "";
  storeArray.forEach(rec => renderOneSticker(layer, storeArray, rec));
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
  closeVoiceModal(); renderBackTracklist(); updateNowPlayingUI(); saveState();
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

// ---------- PLAYER SCREEN ----------
function buildPlayerScreen(){
  selectShell(state.shellShape);
  selectWrapStyle(state.shellWrapStyle);
  // sticker layer rehydrates via showScreen()
}

function shellInnerMarkup(shape){
  const shapeKey = (shape === "boombox" || shape === "carabiner") ? shape : "heart";
  const titleText = escapeHtml(state.tapeTitle);
  const artOverlay = `
      <div class="shell-art-overlay-title" id="shell-art-overlay-title">${titleText}</div>
      <div class="shell-art-overlay-reel left" id="shell-art-overlay-reel-left"><div class="reel-spokes"></div></div>
      <div class="shell-art-overlay-reel right" id="shell-art-overlay-reel-right"><div class="reel-spokes"></div></div>`;
  return `
      <div class="shell-photo-wrap" id="shell-photo-wrap"></div>
      <div class="shell-art-stage">
        <img class="shell-art-img" src="assets/full_recorder_${shapeKey}.svg" alt="${shapeKey} tape shell" draggable="false">
        ${artOverlay}
      </div>
      <div class="shell-sticker-layer" id="shell-sticker-layer"></div>
      <div class="eq-bars" id="eq-bars"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="shell-photo-frame" id="shell-photo-frame"></div>`;
}

function selectShell(shape){
  state.shellShape = shape;
  qsa(".shell-option").forEach(o => o.classList.toggle("active", o.dataset.shell === shape));
  const shell = el("player-shell");
  shell.className = "player-shell shell-" + shape;
  shell.innerHTML = shellInnerMarkup(shape);
  applyShellPhoto();
  rehydrateStickers("shell-sticker-layer", state.shellStickers);
  setupStickerDragDrop("shell-sticker-tray", "shell-sticker-layer", state.shellStickers);
  saveState();
}

function selectWrapStyle(style){
  state.shellWrapStyle = style;
  qsa(".wrap-btn").forEach(b => b.classList.toggle("active", b.dataset.wrap === style));
  applyShellPhoto();
  saveState();
}

function applyShellPhoto(){
  const wrap = el("shell-photo-wrap"); const frame = el("shell-photo-frame");
  if (!wrap || !frame) return;
  wrap.classList.remove("active","fullbody","framed");
  frame.classList.remove("active"); frame.innerHTML = "";

  const useWrap = (state.shellWrapStyle === "fullbody" || state.shellWrapStyle === "both") && state.shellPhoto;
  const useFrame = (state.shellWrapStyle === "framed" || state.shellWrapStyle === "both") && (state.shellWindowPhoto || state.shellPhoto);

  if (useWrap){
    wrap.style.backgroundImage = `url(${state.shellPhoto})`;
    wrap.classList.add("active","fullbody");
  }
  if (useFrame){
    frame.classList.add("active");
    const src = state.shellWindowPhoto || state.shellPhoto;
    frame.innerHTML = `<img src="${src}">`;
  }
}

// ---------- YOUTUBE IFRAME LANE ----------
// Called by the YouTube API when it finishes loading (must be a global)
window.onYouTubeIframeAPIReady = function(){
  // Create the actual player only when we hit the player screen with a track list
  // (delayed until we know what to play; see initYouTubePlayer)
  state.ytReady = true;
};

function initYouTubePlayer(){
  if (!state.ytReady){ setTimeout(initYouTubePlayer, 400); return; }
  if (state.ytPlayer){ return; }
  const host = el("yt-audio-host"); if (!host) return;
  host.innerHTML = `<div id="yt-audio-player"></div>`;
  const opts = {
    height: "1", width: "1",
    playerVars: { playsinline: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: (e) => {
        e.target.setVolume(80);
        // If we already have per-track YT video IDs (Spotify→YT bridge), queue the first one.
        const firstId = getYtIdForTrack(state.currentTrackIndex);
        if (firstId){ e.target.loadVideoById(firstId); }
      },
      onStateChange: (e) => {
        if (e.data === 1){ hideAdCoverAfterDelay(); }
        if (e.data === 0){
          nextTrack(); if (state.isPlaying) crossfadeToTrack(state.currentTrackIndex);
        }
        if (e.data === 3){ showAdCover(); }
      }
    }
  };
  // Only auto-load a YT playlist when the user pasted a YouTube link directly.
  // For Spotify→YT bridge we drive playback one video at a time via loadVideoById().
  if (state.source === "youtube" && state.ytPlaylistId){
    opts.playerVars.listType = "playlist";
    opts.playerVars.list = state.ytPlaylistId;
  }
  // eslint-disable-next-line no-undef
  state.ytPlayer = new YT.Player("yt-audio-player", opts);
}

// Return the YouTube video ID for a given track index (Spotify→YT bridge stores per-track IDs).
function getYtIdForTrack(idx){
  const t = state.tracks[idx];
  return (t && t.ytVideoId) ? t.ytVideoId : null;
}

// Ad-cover overlay: whenever we transition tracks (or hit YT buffering), we show the hiss + play the
// sender's voice memo on top. Legal, cheap, and on-brand.
function showAdCover(){
  state.adCoverActive = true;
  const cover = el("ad-cover"); if (cover) cover.classList.add("active");
  const t = state.tracks[state.currentTrackIndex];
  if (t && t.voiceMemoUrl){
    // If memo is set to "over-ad" or "intro", we play it now over the hiss
    if (t.memoPosition === "over-ad" || t.memoPosition === "intro"){
      const a = new Audio(t.voiceMemoUrl);
      a.play().catch(()=>{});
    }
  }
}
function hideAdCoverAfterDelay(){
  // give a beat for the memo/hiss to finish
  setTimeout(() => {
    state.adCoverActive = false;
    const cover = el("ad-cover"); if (cover) cover.classList.remove("active");
  }, 1200);
}

function crossfadeToTrack(idx){
  showAdCover();
  const t = state.tracks[idx];
  if (state.ytPlayer && t){
    if (state.source === "youtube" && state.ytPlaylistId){
      // native YT playlist mode
      try { state.ytPlayer.playVideoAt(idx % (state.tracks.length || 1)); } catch(_) {}
    } else if (t.ytVideoId){
      // Spotify→YouTube bridge: load the resolved video for this track
      try { state.ytPlayer.loadVideoById(t.ytVideoId); } catch(_) {}
    } else if (t.previewUrl){
      // No YT match found → fall back to Spotify's 30s preview clip so SOMETHING plays
      try {
        const a = new Audio(t.previewUrl);
        a.play().catch(()=>{});
      } catch(_) {}
    }
  }
  updateNowPlayingUI();
}

// ---------- PLAY CONTROLS ----------
function togglePlay(){
  state.isPlaying = !state.isPlaying;
  const playBtn = el("btn-play"); if (playBtn) playBtn.textContent = state.isPlaying ? "⏸️" : "▶️";
  const previewBtn = el("btn-preview-play"); if (previewBtn) previewBtn.textContent = state.isPlaying ? "⏸️" : "▶️";
  const eq = el("eq-bars"); if (eq) eq.classList.toggle("playing", state.isPlaying);
  const reels = qsa("#reel-left, #reel-right, .shell-art-overlay-reel");
  reels.forEach(r => r.classList.toggle("spinning", state.isPlaying));

  if (state.isPlaying){
    initYouTubePlayer();
    // If the YT player is ready, hit play; otherwise the onReady event will pick it up
    if (state.ytPlayer && state.ytPlayer.playVideo){
      try { state.ytPlayer.playVideo(); } catch(_) {}
    }
    updateNowPlayingUI();
  } else {
    if (state.ytPlayer && state.ytPlayer.pauseVideo){
      try { state.ytPlayer.pauseVideo(); } catch(_) {}
    }
    const card = el("now-playing-card"); if (card) card.style.display = "none";
    renderBackTracklist();
  }
}

function nextTrack(){
  if (!state.tracks.length) return;
  state.currentTrackIndex = (state.currentTrackIndex + 1) % state.tracks.length;
  updateNowPlayingUI();
}
function prevTrack(){
  if (!state.tracks.length) return;
  state.currentTrackIndex = (state.currentTrackIndex - 1 + state.tracks.length) % state.tracks.length;
  updateNowPlayingUI();
}

function updateNowPlayingUI(){
  const t = state.tracks[state.currentTrackIndex]; if (!t) return;
  renderBackTracklist();
  const card = el("now-playing-card"); if (!card) return;
  el("np-track").textContent = t.display;
  el("np-artist").textContent = t.artist;
  const orig = el("np-original");
  if (t.display && t.display !== t.original){
    orig.textContent = `ℹ️ originally: ${t.original}`;
    orig.style.display = "block";
  } else { orig.style.display = "none"; }
  const noteEl = el("np-note");
  if (t.note){ noteEl.textContent = `📝 “${t.note}”`; noteEl.style.display = "block"; }
  else { noteEl.textContent = ""; noteEl.style.display = "none"; }
  const voiceBtn = el("np-voice-btn");
  if (t.voiceMemoUrl){
    voiceBtn.style.display = "inline-flex";
    voiceBtn.onclick = () => { const a = new Audio(t.voiceMemoUrl); a.play().catch(()=>{}); };
  } else { voiceBtn.style.display = "none"; voiceBtn.onclick = null; }
  card.style.display = state.isPlaying ? "flex" : "none";
  card.classList.remove("note-pop"); void card.offsetWidth; card.classList.add("note-pop");
}

// ---------- SEND SCREEN / QR ----------
// v0.6: Send saves the whole decorated tape (memos, photos, stickers, letter) to
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
function stickerPayload(list){
  return (list || []).map(st => ({
    emoji: st.emoji, x: Math.round(st.x * 10) / 10, y: Math.round(st.y * 10) / 10,
    size: Math.round(st.size || 44), rotation: Math.round(st.rotation || 0)
  }));
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
      memoPosition: t.memoPosition, ytVideoId: t.ytVideoId || null
    })),
    stickersFront: stickerPayload(state.coverStickers),
    stickersShell: stickerPayload(state.shellStickers),
    skin: state.skin, shell: state.shellShape, wrapStyle: state.shellWrapStyle,
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
    const photos = [["cover", state.coverPhoto], ["shellPhoto", state.shellPhoto], ["windowPhoto", state.shellWindowPhoto]];
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

  setupStickerDragDrop("sticker-tray", "front-sticker-layer", state.coverStickers);
  setupPhotoUpload("cover-photo-input", (dataUrl) => {
    state.coverPhoto = dataUrl;
    const slot = el("cassette-photo-slot");
    slot.style.backgroundImage = `url(${dataUrl})`;
    slot.querySelector(".cassette-photo-placeholder").style.display = "none";
    saveState();
  });
  el("cassette-photo-slot").addEventListener("click", () => el("cover-photo-input").click());

  el("btn-flip-to-back").addEventListener("click", () => flipCassette(true));
  el("btn-flip-to-front").addEventListener("click", () => flipCassette(false));

  el("btn-open-letter").addEventListener("click", openLetterModal);
  el("letter-close").addEventListener("click", closeLetterModal);
  el("btn-save-letter").addEventListener("click", saveLetter);

  el("voice-modal-close").addEventListener("click", closeVoiceModal);
  el("btn-record").addEventListener("click", toggleRecording);
  el("btn-save-voice").addEventListener("click", saveVoice);

  el("btn-to-player").addEventListener("click", playClosingTransitionThenGoToPlayer);
  el("btn-back-to-cover").addEventListener("click", () => showScreen("screen-tape"));

  qsa(".shell-option").forEach(o => o.addEventListener("click", () => selectShell(o.dataset.shell)));
  qsa(".wrap-btn").forEach(b => b.addEventListener("click", () => selectWrapStyle(b.dataset.wrap)));
  setupPhotoUpload("shell-photo-input", (dataUrl) => { state.shellPhoto = dataUrl; applyShellPhoto(); saveState(); });
  setupPhotoUpload("shell-window-photo-input", (dataUrl) => { state.shellWindowPhoto = dataUrl; applyShellPhoto(); saveState(); });

  el("btn-play").addEventListener("click", togglePlay);
  el("btn-rewind").addEventListener("click", () => {
    el("btn-rewind").style.transform="scale(0.85) rotate(-15deg)"; setTimeout(()=>el("btn-rewind").style.transform="",200);
    prevTrack(); if (state.isPlaying) crossfadeToTrack(state.currentTrackIndex);
  });
  el("btn-ff").addEventListener("click", () => {
    el("btn-ff").style.transform="scale(0.85) rotate(15deg)"; setTimeout(()=>el("btn-ff").style.transform="",200);
    nextTrack(); if (state.isPlaying) crossfadeToTrack(state.currentTrackIndex);
  });
  const previewPlayBtn = el("btn-preview-play");
  if (previewPlayBtn) previewPlayBtn.addEventListener("click", togglePlay);

  el("btn-to-send").addEventListener("click", () => { currentSend = null; buildSendScreen(); showScreen("screen-send"); });
  el("btn-send-tape").addEventListener("click", sendTape);
  el("btn-back-to-player").addEventListener("click", () => showScreen("screen-player"));

  el("btn-share").addEventListener("click", shareTape);
  el("btn-copy").addEventListener("click", copyLink);
});
// v4.1 build - 2026-09-20T18:05:10Z
