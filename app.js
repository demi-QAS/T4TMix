// ============ T4T Mix — app logic ============

const SKINS = {
  trans: { bg: "linear-gradient(160deg, #5BCEFA, #F5A9B8)", flat:"#5BCEFA", label:"Trans" },
  lesbian: { bg: "linear-gradient(160deg, #D62900, #FF9B55, #D462A6, #A50062)", flat:"#D462A6", label:"Lesbian" },
  bi: { bg: "linear-gradient(160deg, #D60270, #9B4F96, #0038A8)", flat:"#9B4F96", label:"Bi" },
  nb: { bg: "linear-gradient(160deg, #FCF434, #9C59D1, #2C2C2C)", flat:"#9C59D1", label:"Nonbinary" },
  pride: { bg: "linear-gradient(160deg, #E70000, #FF8C00, #FFEF00, #00811F, #0044FF, #760089)", flat:"#8c00b0", label:"Pride" }
};

const PLAYLIST_ID = "7ldeWYMpsY7YxGPYDSmW9p";
const PLAYLIST_URL = `https://open.spotify.com/playlist/${PLAYLIST_ID}`;
const EMBED_URL = `https://open.spotify.com/embed/playlist/${PLAYLIST_ID}?utm_source=generator&theme=0`;

// fallback tracklist in case oEmbed title fetch fails — still lets the demo feel real
const FALLBACK_TRACKS = [
  "Track 1", "Track 2", "Track 3", "Track 4", "Track 5", "Track 6"
];

let state = {
  skin: "trans",
  title: "a mix for you",
  stickers: [], // {emoji, x, y}
  photo: null,
  tracks: [],
  notes: {}, // trackIndex -> {text, audioUrl}
  activeTrackIndex: null,
  recordedBlobUrl: null,
  mediaRecorder: null,
  audioChunks: [],
  recordTimerInterval: null,
  recordSeconds: 0
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showScreen(id){
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
  window.scrollTo({top:0, behavior:'smooth'});
}

// ---------- HERO -> LOAD PLAYLIST ----------
$('#btn-load').addEventListener('click', async () => {
  const url = $('#spotify-input').value.trim();
  $('#btn-load').textContent = "loading...";
  await loadPlaylist(url);
  $('#btn-load').textContent = "Load my playlist →";
  showScreen('screen-builder');
});

async function loadPlaylist(url){
  // Try to extract real playlist title via oEmbed (public, no auth) — falls back gracefully
  let title = "your playlist";
  try {
    const resp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if(resp.ok){
      const data = await resp.json();
      if(data.title) title = data.title;
    }
  } catch(e){ /* silently fall back — likely CORS in this environment, embed still works */ }

  $('#playlist-title-display').textContent = `🎧 from: ${title}`;

  // Embed the real Spotify player (this always works, no API key needed)
  $('#spotify-embed-wrap').innerHTML = `<iframe src="${EMBED_URL}" width="100%" height="352" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;

  // Build a simple tap-to-annotate track list.
  // Spotify's embed iframe doesn't expose track titles to outside scripts (cross-origin),
  // so we generate a clean numbered list the sender can label & annotate directly —
  // paired with the real embedded player above showing real art & audio.
  state.tracks = FALLBACK_TRACKS.map((t, i) => `Song ${i+1}`);
  renderTrackList();
}

function renderTrackList(){
  const wrap = $('#track-list');
  wrap.innerHTML = '';
  state.tracks.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'track-row' + (state.notes[i] ? ' has-note' : '');
    row.innerHTML = `<span class="tnum">${i+1}</span><span class="tname" contenteditable="true" data-idx="${i}">${name}</span><span class="tnote-icon">💌</span>`;
    row.addEventListener('click', (e) => {
      if(e.target.classList.contains('tname')) return; // let editing happen
      openNoteModal(i);
    });
    row.querySelector('.tname').addEventListener('click', (e) => e.stopPropagation());
    row.querySelector('.tname').addEventListener('blur', (e) => {
      state.tracks[i] = e.target.textContent.trim() || `Song ${i+1}`;
    });
    wrap.appendChild(row);
  });
}

// ---------- SKIN PICKER ----------
$$('.skin-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    $$('.skin-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    state.skin = sw.dataset.skin;
    applySkin();
  });
});
function applySkin(){
  const skin = SKINS[state.skin];
  $('#cassette').querySelector('.cassette-body').style.setProperty('--body-bg', skin.bg);
  $('#cassette').querySelector('.cassette-body').style.background = skin.bg;
  document.documentElement.style.setProperty('--body-bg-flat', skin.flat);
  $('#qr-card').style.borderColor = skin.flat;
}

// ---------- TITLE EDIT ----------
$('#title-input').addEventListener('input', (e) => {
  state.title = e.target.value || 'a mix for you';
  $('#label-title').textContent = state.title;
  $('#qr-caption').textContent = state.title;
});

// ---------- STICKERS (drag & drop) ----------
$$('.sticker-item').forEach(item => {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('emoji', item.dataset.emoji);
  });
  // mobile fallback: tap to drop centered with slight random offset
  item.addEventListener('click', () => {
    placeSticker(item.dataset.emoji, 40 + Math.random()*40, 10 + Math.random()*30);
  });
});
const labelEl = $('#cassette-label');
labelEl.addEventListener('dragover', (e) => e.preventDefault());
labelEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const emoji = e.dataTransfer.getData('emoji');
  if(!emoji) return;
  const rect = labelEl.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top) / rect.height) * 100;
  placeSticker(emoji, xPct, yPct);
});

function placeSticker(emoji, xPct, yPct){
  const s = { emoji, x: xPct, y: yPct, id: Date.now() + Math.random() };
  state.stickers.push(s);
  renderStickers();
}
function renderStickers(){
  const layer = $('#sticker-layer');
  layer.innerHTML = '';
  state.stickers.forEach(s => {
    const el = document.createElement('span');
    el.className = 'placed-sticker';
    el.textContent = s.emoji;
    el.style.left = `${s.x}%`;
    el.style.top = `${s.y}%`;
    el.title = 'tap to remove';
    el.addEventListener('click', () => {
      state.stickers = state.stickers.filter(st => st.id !== s.id);
      renderStickers();
    });
    layer.appendChild(el);
  });
}

// ---------- PHOTO UPLOAD ----------
$('#photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.photo = ev.target.result;
    $('#photo-layer').innerHTML = `<img src="${state.photo}" alt="your photo">`;
  };
  reader.readAsDataURL(file);
});

// ---------- CASSETTE CONTROLS ----------
let isPlaying = false;
$('#btn-play').addEventListener('click', () => {
  isPlaying = !isPlaying;
  $('#reel-left').classList.toggle('spinning', isPlaying);
  $('#reel-right').classList.toggle('spinning', isPlaying);
  $('#btn-play').textContent = isPlaying ? '⏸️' : '▶️';
});
$('#btn-rewind').addEventListener('click', () => bumpReels(-1));
$('#btn-ff').addEventListener('click', () => bumpReels(1));
function bumpReels(dir){
  const cassette = $('#cassette');
  cassette.style.transform = `rotateX(18deg) rotateY(${dir*8-14}deg) rotateZ(2deg)`;
  setTimeout(() => { cassette.style.transform = ''; }, 300);
}
$('#btn-eject').addEventListener('click', () => {
  $('#cassette').classList.toggle('ejected');
});

// ---------- NOTE MODAL ----------
function openNoteModal(idx){
  state.activeTrackIndex = idx;
  $('#modal-track-name').textContent = `🎵 ${state.tracks[idx]}`;
  $('#modal-note-text').value = state.notes[idx]?.text || '';
  const playback = $('#voice-playback');
  if(state.notes[idx]?.audioUrl){
    playback.src = state.notes[idx].audioUrl;
    playback.style.display = 'block';
  } else {
    playback.style.display = 'none';
    playback.src = '';
  }
  resetRecordUI();
  $('#note-modal').classList.add('active');
}
$('#modal-close').addEventListener('click', () => $('#note-modal').classList.remove('active'));
$('#note-modal').addEventListener('click', (e) => { if(e.target.id === 'note-modal') $('#note-modal').classList.remove('active'); });

$('#btn-save-note').addEventListener('click', () => {
  const idx = state.activeTrackIndex;
  const text = $('#modal-note-text').value.trim();
  const audioUrl = state.recordedBlobUrl || state.notes[idx]?.audioUrl || null;
  if(text || audioUrl){
    state.notes[idx] = { text, audioUrl };
  } else {
    delete state.notes[idx];
  }
  state.recordedBlobUrl = null;
  renderTrackList();
  $('#note-modal').classList.remove('active');
});

// ---------- VOICE MEMO RECORDING ----------
const MAX_RECORD_SECONDS = 20;
function resetRecordUI(){
  $('#btn-record').textContent = '🎙️ record';
  $('#btn-record').classList.remove('recording');
  $('#record-timer').textContent = '0:00';
  state.recordSeconds = 0;
  clearInterval(state.recordTimerInterval);
}

$('#btn-record').addEventListener('click', async () => {
  if(state.mediaRecorder && state.mediaRecorder.state === 'recording'){
    state.mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const recorder = new MediaRecorder(stream);
    state.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => state.audioChunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(state.audioChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      state.recordedBlobUrl = url;
      const playback = $('#voice-playback');
      playback.src = url;
      playback.style.display = 'block';
      stream.getTracks().forEach(t => t.stop());
      resetRecordUI();
    };

    recorder.start();
    $('#btn-record').textContent = '⏹️ stop';
    $('#btn-record').classList.add('recording');
    state.recordSeconds = 0;
    state.recordTimerInterval = setInterval(() => {
      state.recordSeconds++;
      const m = Math.floor(state.recordSeconds / 60);
      const s = state.recordSeconds % 60;
      $('#record-timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
      if(state.recordSeconds >= MAX_RECORD_SECONDS){
        recorder.stop();
      }
    }, 1000);
  } catch(err){
    alert("Couldn't access your microphone — check your browser's mic permission and try again. (You can still type a note instead!)");
  }
});

// ---------- FINISH -> QR / SEND SCREEN ----------
$('#btn-to-send').addEventListener('click', () => {
  $('#qr-caption').textContent = state.title;
  applySkin();
  generateQR();
  showScreen('screen-send');
});
$('#btn-back-to-builder').addEventListener('click', () => showScreen('screen-builder'));

function generateQR(){
  const holder = $('#qr-canvas-holder');
  holder.innerHTML = '';
  try {
    new QRCode(holder, {
      text: PLAYLIST_URL,
      width: 220,
      height: 220,
      colorDark: '#2b2036',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } catch(err){
    holder.textContent = 'Could not generate QR — link: ' + PLAYLIST_URL;
  }
}

// ---------- SHARE / COPY ----------
$('#btn-share').addEventListener('click', async () => {
  const shareData = {
    title: `T4T Mix: ${state.title}`,
    text: `🎧 ${state.title} — made you a mixtape. no gatekeeping, just good taste.`,
    url: PLAYLIST_URL
  };
  if(navigator.share){
    try { await navigator.share(shareData); } catch(e){ /* user cancelled */ }
  } else {
    copyLink();
    alert('Native share isn\'t available in this browser — link copied instead! Paste it anywhere 💌');
  }
});
$('#btn-copy').addEventListener('click', copyLink);
function copyLink(){
  navigator.clipboard.writeText(PLAYLIST_URL).then(() => {
    const btn = $('#btn-copy');
    const original = btn.textContent;
    btn.textContent = '✓ copied!';
    setTimeout(() => btn.textContent = original, 1500);
  });
}

// ---------- INIT ----------
applySkin();
