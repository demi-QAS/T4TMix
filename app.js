// ============ T4T Mix v3 — the tape IS the canvas ============

const FALLBACK_TRACKS = [
  { title: "every day is a game", artist: "Night Tapes" },
  { title: "EAT YOU UP", artist: "r u s s e l   b u c k" },
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
const WORKER_URL = ""; // set once the Cloudflare Worker is deployed

const SKIN_GRADIENTS = {
  trans:  { shell:"linear-gradient(160deg,#e8e0d6,#d8cabf)", label:"#fbf6ea", tag:"#3a8fc7", spine:"linear-gradient(180deg,#5BCEFA,#F5A9B8)", shellPlayer:"linear-gradient(160deg,#5BCEFA,#F5A9B8)", shellFlat:"#5BCEFA", qr:"#5BCEFA" },
  lesbian:{ shell:"linear-gradient(160deg,#f0ddd2,#e0bfae)", label:"#fff3ec", tag:"#a83a1f", spine:"linear-gradient(180deg,#D62900,#D462A6)", shellPlayer:"linear-gradient(160deg,#D62900,#FF9B55,#D462A6)", shellFlat:"#D62900", qr:"#D462A6" },
  bi:     { shell:"linear-gradient(160deg,#ecdcec,#d8bfe0)", label:"#fdf3fb", tag:"#8a3a8a", spine:"linear-gradient(180deg,#D60270,#0038A8)", shellPlayer:"linear-gradient(160deg,#D60270,#9B4F96,#0038A8)", shellFlat:"#9B4F96", qr:"#9B4F96" },
  nb:     { shell:"linear-gradient(160deg,#eeeadc,#d9cfe0)", label:"#fdfbe8", tag:"#7a5aa8", spine:"linear-gradient(180deg,#FCF434,#9C59D1)", shellPlayer:"linear-gradient(160deg,#FCF434,#9C59D1,#2C2C2C)", shellFlat:"#9C59D1", qr:"#9C59D1" },
  pride:  { shell:"linear-gradient(160deg,#ede4d4,#d6c9e0)", label:"#fdf8ea", tag:"#4a2e6a", spine:"linear-gradient(180deg,#E70000,#0044FF)", shellPlayer:"linear-gradient(160deg,#E70000,#FF8C00,#FFEF00,#00811F,#0044FF,#760089)", shellFlat:"#760089", qr:"#760089" }
};

const TRACK_DEMO_DURATION_MS = 9000; // demo pacing only — real per-track boundaries need Spotify's Web Playback SDK (Premium OAuth) or the YouTube IFrame Player API; a hidden embed can't report that back to us, that's a backend/auth follow-up

const state = {
  source: "spotify", playlistUrl: "", playlistId: "", playlistTitle: "",
  tapeTitle: "a mix for you", skin: "trans",
  tracks: [], coverPhoto: null, coverStickers: [],
  letterText: "",
  shellShape: "boombox", shellPhoto: null, shellWrapStyle: "fullbody", shellStickers: [],
  activeTrackIndex: null, mediaRecorder: null, recordedChunks: [], recordTimerInterval: null,
  isPlaying: false, mixtapesSentThisMonth: 1,
  currentTrackIndex: 0, playbackTimer: null
};
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function el(id){ return document.getElementById(id); }
function qs(sel, root){ return (root||document).querySelector(sel); }
function qsa(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
function extractSpotifyId(url){ const m = url.match(/playlist[\/:]([a-zA-Z0-9]+)/); return m ? m[1] : null; }
function extractYouTubeListId(url){ const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/); return m ? m[1] : null; }

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
    state.playlistUrl = ytmUrl; state.playlistId = listId || "";
    state.playlistTitle = "your YouTube Music mix";
    state.tracks = FALLBACK_TRACKS.map(t => ({ ...t, note:"", voiceMemoUrl:null }));
    statusEl.textContent = "YouTube playlist embedded — song-by-song titles need the Worker backend (see README).";
  } else if (spotifyUrl){
    state.source = "spotify";
    const id = extractSpotifyId(spotifyUrl);
    state.playlistUrl = spotifyUrl; state.playlistId = id || "";
    if (WORKER_URL && id){
      try {
        const resp = await fetch(`${WORKER_URL}?id=${id}`);
        if (!resp.ok) throw new Error("worker not ready");
        const data = await resp.json();
        state.playlistTitle = data.title || FALLBACK_PLAYLIST_TITLE;
        state.tracks = (data.tracks || FALLBACK_TRACKS).map(t => ({ title:t.title, artist:t.artist, note:"", voiceMemoUrl:null }));
        statusEl.textContent = "loaded live from your Worker ✓";
      } catch(e){ useFallbackTracks(statusEl); }
    } else { useFallbackTracks(statusEl); }
  } else {
    statusEl.textContent = "paste a playlist link first 👀";
    return;
  }

  el("handwritten-title").textContent = state.tapeTitle;
  buildTapeScreen();
  showScreen("screen-tape");
}
function useFallbackTracks(statusEl){
  state.playlistTitle = FALLBACK_PLAYLIST_TITLE;
  state.tracks = FALLBACK_TRACKS.map(t => ({ ...t, note:"", voiceMemoUrl:null }));
  statusEl.textContent = "loaded ✓ (using saved track data — connect the Worker for fully live fetches, see README)";
}

// ---------- TAPE SCREEN (front label + back tracklist) ----------
function buildTapeScreen(){
  el("playlist-title-display").textContent = state.playlistTitle;

  // hidden embed kept alive for actual audio source, not shown as UI chrome anymore
  const embedWrap = el("source-embed-wrap");
  embedWrap.innerHTML = "";
  if (state.source === "spotify" && state.playlistId){
    const iframe = document.createElement("iframe");
    iframe.src = `https://open.spotify.com/embed/playlist/${state.playlistId}`;
    iframe.width = "1"; iframe.height = "1"; iframe.frameBorder = "0";
    iframe.style.border = "0";
    embedWrap.appendChild(iframe);
  }

  renderBackTracklist();
  applySkin(state.skin);
  updateLetterTabState();
}

function renderBackTracklist(){
  const wrap = el("back-tracklist");
  wrap.innerHTML = "";
  state.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    const isNowPlaying = state.isPlaying && i === state.currentTrackIndex;
    row.className = "btk-row" + (isNowPlaying ? " now-playing" : "");
    // icon tells you the state at a glance: has a voice memo, has a written note, or empty (tap to add)
    const icon = t.voiceMemoUrl ? "🎙️" : (t.note ? "📝" : "✏️");
    const memoClass = (t.voiceMemoUrl || t.note) ? "has-memo" : "";
    row.innerHTML = `
      <div class="btk-row-main">
        <span class="btk-num">${i+1}.</span>
        <span class="btk-title" data-idx="${i}">${escapeHtml(t.title)} <span class="btk-artist">— ${escapeHtml(t.artist)}</span></span>
        <span class="btk-memo-dot ${memoClass}" title="add a note or voice memo">${icon}</span>
      </div>
      ${t.note ? `<div class="btk-note-preview">📝 “${escapeHtml(t.note)}”</div>` : ""}
    `;
    const titleSpan = row.querySelector(".btk-title");
    titleSpan.addEventListener("click", (e) => {
      // clicking the memo icon opens the note/voice modal; clicking the title text edits inline
      startEditingBackTitle(titleSpan, i);
    });
    row.querySelector(".btk-memo-dot").addEventListener("click", (e) => {
      e.stopPropagation(); openVoiceModal(i);
    });
    wrap.appendChild(row);
    if (isNowPlaying){ row.scrollIntoView({ block:"nearest", behavior:"smooth" }); }
  });
}

function startEditingBackTitle(span, idx){
  const track = state.tracks[idx];
  span.contentEditable = "true";
  span.classList.add("editing");
  // strip artist suffix while editing, keep only title text
  span.textContent = track.title;
  span.focus();
  const range = document.createRange(); range.selectNodeContents(span); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);

  const commit = () => {
    span.contentEditable = "false"; span.classList.remove("editing");
    const newTitle = span.textContent.trim() || track.title;
    state.tracks[idx].title = newTitle;
    span.innerHTML = `${newTitle} <span class="btk-artist">— ${track.artist}</span>`;
    span.removeEventListener("blur", commit);
    span.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Enter"){ e.preventDefault(); span.blur(); } };
  span.addEventListener("blur", commit);
  span.addEventListener("keydown", onKey);
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
}

// ---------- CASSETTE FLIP ----------
function flipCassette(toBack){
  el("cassette-flipper").classList.toggle("flipped", toBack);
}

// ---------- STICKERS ----------
function setupStickerDragDrop(trayId, targetLayerId, storeArray){
  const tray = el(trayId);
  qsa(".sticker-item", tray).forEach(item => {
    item.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", item.dataset.emoji));
    item.addEventListener("click", () => {
      const x = 15 + Math.random()*55, y = 10 + Math.random()*45;
      addStickerToLayer(targetLayerId, storeArray, item.dataset.emoji, x, y);
    });
  });
  const layer = el(targetLayerId);
  layer.addEventListener("dragover", (e) => e.preventDefault());
  layer.addEventListener("drop", (e) => {
    e.preventDefault();
    const emoji = e.dataTransfer.getData("text/plain");
    if (!emoji) return;
    const rect = layer.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    addStickerToLayer(targetLayerId, storeArray, emoji, x, y);
  });
}
function addStickerToLayer(layerId, storeArray, emoji, xPct, yPct){
  const layer = el(layerId);
  const s = document.createElement("div");
  s.className = "placed-sticker"; s.textContent = emoji;
  s.style.left = xPct + "%"; s.style.top = yPct + "%";
  s.addEventListener("click", (e) => { e.stopPropagation(); s.remove(); });
  layer.appendChild(s);
  storeArray.push({ emoji, x:xPct, y:yPct });
}

// ---------- PHOTO UPLOADS ----------
function setupPhotoUpload(inputId, callback){
  el(inputId).addEventListener("change", (e) => {
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
  closeLetterModal();
  updateLetterTabState();
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

// ---------- VOICE MEMO MODAL (per track, opened from back tracklist) ----------
function openVoiceModal(idx){
  state.activeTrackIndex = idx;
  const t = state.tracks[idx];
  el("voice-track-name").textContent = t.title;
  el("voice-track-artist").textContent = t.artist;
  el("track-note-text").value = t.note || "";
  const playback = el("voice-playback");
  if (t.voiceMemoUrl){ playback.src = t.voiceMemoUrl; playback.style.display = "block"; }
  else { playback.style.display = "none"; playback.src = ""; }
  el("record-timer").textContent = "0:00";
  el("voice-modal").classList.add("active");
}
function closeVoiceModal(){ el("voice-modal").classList.remove("active"); stopRecordingIfActive(); }
function saveVoice(){
  // this was the actual bug behind "the note looks faded": the textarea never wrote to state, so nothing ever rendered
  if (state.activeTrackIndex !== null){
    state.tracks[state.activeTrackIndex].note = el("track-note-text").value.trim();
  }
  closeVoiceModal();
  renderBackTracklist();
  updateNowPlayingUI();
}

let recordStartTime = null;
async function toggleRecording(){
  const btn = el("btn-record");
  if (state.mediaRecorder && state.mediaRecorder.state === "recording"){ stopRecordingIfActive(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    state.recordedChunks = [];
    const mr = new MediaRecorder(stream);
    state.mediaRecorder = mr;
    mr.ondataavailable = (e) => state.recordedChunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type:"audio/webm" });
      const url = URL.createObjectURL(blob);
      if (state.activeTrackIndex !== null){ state.tracks[state.activeTrackIndex].voiceMemoUrl = url; }
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
  const overlay = el("closing-overlay");
  overlay.classList.add("active");
  setTimeout(() => {
    overlay.classList.remove("active");
    buildPlayerScreen();
    showScreen("screen-player");
  }, 1150);
}

// ---------- PLAYER SCREEN ----------
function buildPlayerScreen(){
  selectShell(state.shellShape);
  selectWrapStyle(state.shellWrapStyle);
}
function shellInnerMarkup(shape){
  // REAL SHELL ART: renders the locked full_recorder_{shape}.svg (metal body,
  // anodized sheen, 3-ring glass seam, hand-etched hatch, baked SIDE A / track
  // chip) as the shell's actual visual, with only the two LIVE bits — the tape
  // title text and the two spinning reels — drawn on top as absolutely
  // positioned overlays using the exact px geometry computed from the Python
  // build (see build_scripts/ + the --ov-* comment block above .shell-art-stage
  // in style.css). This replaces the old flat CSS-shape / emoji placeholder.
  const shapeKey = (shape === "boombox" || shape === "carabiner") ? shape : "heart";
  const titleText = escapeHtml(state.tapeTitle);
  const artOverlay = `
      <div class="shell-art-overlay-title" id="shell-art-overlay-title">${titleText}</div>
      <div class="shell-art-overlay-reel left" id="shell-art-overlay-reel-left"><div class="reel-spokes"></div></div>
      <div class="shell-art-overlay-reel right" id="shell-art-overlay-reel-right"><div class="reel-spokes"></div></div>`;
  return `
      <div class="shell-art-stage">
        <img class="shell-art-img" src="assets/full_recorder_${shapeKey}.svg" alt="${shapeKey} tape shell" draggable="false">
        ${artOverlay}
      </div>
      <div class="shell-photo-wrap" id="shell-photo-wrap"></div>
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
  state.shellStickers.forEach(s => {
    const layer = el("shell-sticker-layer");
    const s2 = document.createElement("div");
    s2.className = "placed-sticker"; s2.textContent = s.emoji;
    s2.style.left = s.x + "%"; s2.style.top = s.y + "%";
    s2.addEventListener("click", (e) => { e.stopPropagation(); s2.remove(); });
    layer.appendChild(s2);
  });
  setupStickerDragDrop("shell-sticker-tray", "shell-sticker-layer", state.shellStickers);
}
function selectWrapStyle(style){
  state.shellWrapStyle = style;
  qsa(".wrap-btn").forEach(b => b.classList.toggle("active", b.dataset.wrap === style));
  applyShellPhoto();
}
function applyShellPhoto(){
  const wrap = el("shell-photo-wrap"); const frame = el("shell-photo-frame");
  if (!wrap || !frame) return;
  if (state.shellPhoto){
    if (state.shellWrapStyle === "fullbody"){
      wrap.style.backgroundImage = `url(${state.shellPhoto})`;
      wrap.classList.add("active","fullbody"); wrap.classList.remove("framed");
      frame.classList.remove("active"); frame.innerHTML = "";
    } else {
      wrap.classList.remove("active"); frame.classList.add("active");
      frame.innerHTML = `<img src="${state.shellPhoto}">`;
    }
  } else { wrap.classList.remove("active"); frame.classList.remove("active"); frame.innerHTML = ""; }
}
function togglePlay(){
  state.isPlaying = !state.isPlaying;
  const playBtn = el("btn-play"); if (playBtn) playBtn.textContent = state.isPlaying ? "⏸️" : "▶️";
  const previewBtn = el("btn-preview-play"); if (previewBtn) previewBtn.textContent = state.isPlaying ? "⏸️" : "▶️";
  const eq = el("eq-bars"); if (eq) eq.classList.toggle("playing", state.isPlaying);
  const reels = qsa("#reel-left, #reel-right, .shell-art-overlay-reel"); // big cassette reels + player-shell art-overlay reels
  reels.forEach(r => r.classList.toggle("spinning", state.isPlaying));
  if (state.isPlaying){ startPlaybackCycle(); }
  else {
    stopPlaybackCycle();
    const card = el("now-playing-card"); if (card) card.style.display = "none";
    renderBackTracklist();
  }
}

// ---------- SIMULATED "NOW PLAYING" ENGINE ----------
// Pacing here is a fixed demo interval so notes/voice memos visibly surface as songs
// change. True per-track boundaries need Spotify's Web Playback SDK (Premium OAuth)
// or the YouTube IFrame Player API's onStateChange — the hidden 1px embed we use for
// audio can't report that back to us. Flagging honestly: that wiring is a backend/auth
// pass, not something to fake here.
function startPlaybackCycle(){
  stopPlaybackCycle();
  updateNowPlayingUI();
  state.playbackTimer = setInterval(nextTrack, TRACK_DEMO_DURATION_MS);
}
function stopPlaybackCycle(){
  if (state.playbackTimer){ clearInterval(state.playbackTimer); state.playbackTimer = null; }
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
  const t = state.tracks[state.currentTrackIndex];
  if (!t) return;

  // Side B: highlight + auto-scroll the currently "playing" row so its note pops into view
  renderBackTracklist();

  // Player screen now-playing card
  const card = el("now-playing-card");
  if (!card) return;
  el("np-track").textContent = t.title;
  el("np-artist").textContent = t.artist;
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
function buildSendScreen(){
  el("qr-caption").textContent = state.tapeTitle;
  const holder = el("qr-canvas-holder"); holder.innerHTML = "";
  const linkToEncode = state.playlistUrl;
  // eslint-disable-next-line no-undef
  new QRCode(holder, { text: linkToEncode, width:220, height:220, colorDark:"#2b2036", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.H });
}
function shareTape(){
  const text = `🎧 made you a "${state.tapeTitle}" mixtape — no necklace, just this: ${state.playlistUrl}`;
  if (navigator.share){ navigator.share({ title: state.tapeTitle, text, url: state.playlistUrl }).catch(()=>{}); }
  else { copyLink(); }
}
function copyLink(){
  navigator.clipboard.writeText(state.playlistUrl).then(() => {
    const btn = el("btn-copy"); const original = btn.textContent;
    btn.textContent = "✅ copied!"; setTimeout(() => btn.textContent = original, 1600);
  });
}

// ---------- WIRE UP ----------
document.addEventListener("DOMContentLoaded", () => {
  el("btn-load").addEventListener("click", loadPlaylist);

  // handwritten title directly on label (contenteditable)
  const titleEl = el("handwritten-title");
  titleEl.addEventListener("input", () => {
    state.tapeTitle = titleEl.textContent.trim() || "a mix for you";
    const shellTitle = el("shell-art-overlay-title");
    if (shellTitle) shellTitle.textContent = state.tapeTitle;
  });
  titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); titleEl.blur(); } });

  qsa(".skin-swatch").forEach(sw => sw.addEventListener("click", () => applySkin(sw.dataset.skin)));

  setupStickerDragDrop("sticker-tray", "front-sticker-layer", state.coverStickers);
  setupPhotoUpload("cover-photo-input", (dataUrl) => {
    state.coverPhoto = dataUrl;
    const slot = el("cassette-photo-slot");
    slot.style.backgroundImage = `url(${dataUrl})`;
    slot.querySelector(".cassette-photo-placeholder").style.display = "none";
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
  setupPhotoUpload("shell-photo-input", (dataUrl) => { state.shellPhoto = dataUrl; applyShellPhoto(); });

  el("btn-play").addEventListener("click", togglePlay);
  el("btn-rewind").addEventListener("click", () => {
    el("btn-rewind").style.transform="scale(0.85) rotate(-15deg)"; setTimeout(()=>el("btn-rewind").style.transform="",200);
    prevTrack(); if (state.isPlaying) startPlaybackCycle();
  });
  el("btn-ff").addEventListener("click", () => {
    el("btn-ff").style.transform="scale(0.85) rotate(15deg)"; setTimeout(()=>el("btn-ff").style.transform="",200);
    nextTrack(); if (state.isPlaying) startPlaybackCycle();
  });
  const previewPlayBtn = el("btn-preview-play");
  if (previewPlayBtn) previewPlayBtn.addEventListener("click", togglePlay);

  el("btn-to-send").addEventListener("click", () => { buildSendScreen(); showScreen("screen-send"); });
  el("btn-back-to-player").addEventListener("click", () => showScreen("screen-player"));

  el("btn-share").addEventListener("click", shareTape);
  el("btn-copy").addEventListener("click", copyLink);
});
