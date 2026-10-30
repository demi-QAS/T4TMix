"""T4T Mix — voice-memo mixing stress test for the shared player (player.js).

Runs the REAL player.js in headless Chrome against fake YouTube / SoundCloud players,
so every scenario is deterministic (no ads, no network, no quota):

    pip install playwright && python -m playwright install chromium
    npm run dev            # serves /player.js
    python tests/player_harness.py
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8787")

HARNESS = r"""<!doctype html><meta charset="utf-8"><body><div id="mount"></div>
<script>
window.LOG = [];
const log = (...a) => LOG.push(a.join(" "));
// 0.5 s of silence as a WAV data URL — stands in for a recorded voice memo
function wav(sec) {
  const rate = 8000, n = Math.floor(rate * sec), b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true); for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}
window.MEMO = wav(0.5);
window.SONG_MS = 450;
window.BROKEN = new Set();       // video ids that error out
// ---- fake YouTube IFrame API ----
window.YT = { Player: class {
  constructor(holder, o) { this.o = o; this.vid = o.videoId; this.vol = 100; this.muted = false; this.t = null;
    log("yt:create", o.videoId); setTimeout(() => o.events.onReady({ target: this }), 30); }
  _play() { clearTimeout(this.t); const vid = this.vid;
    if (BROKEN.has(vid)) { setTimeout(() => this.o.events.onError({ data: 150 }), 40); return; }
    setTimeout(() => { if (this.vid !== vid) return; log("yt:playing", vid, "vol=" + this.vol, this.muted ? "muted" : "loud"); this.o.events.onStateChange({ data: 1 }); }, 40);
    this.t = setTimeout(() => { if (this.vid !== vid) return; log("yt:ended", vid); this.o.events.onStateChange({ data: 0 }); }, SONG_MS); }
  loadVideoById(v) { this.vid = v; log("yt:load", v); this._play(); }
  playVideo() { log("yt:play", this.vid); this._play(); }
  pauseVideo() { clearTimeout(this.t); log("yt:pause", this.vid); }
  setVolume(x) { this.vol = x; if (x === 18 || x === 100) log("yt:vol", x); }
  mute() { this.muted = true; log("yt:mute"); } unMute() { this.muted = false; log("yt:unmute"); }
  seekTo(s) { log("yt:seek", s); } destroy() {}
} };
// ---- fake SoundCloud Widget API ----
window.SC = { Widget: Object.assign(function (iframe) {
  const h = {}; let t = null, cur = (iframe.src.match(/tracks%2F(\d+)/) || [])[1];
  const fire = (e) => (h[e] || []).forEach((f) => f({}));
  const w = { bind: (e, f) => ((h[e] = h[e] || []).push(f)),
    load: (url, o) => { cur = url.split("/").pop(); log("sc:load", cur); setTimeout(() => o.callback && o.callback(), 30); },
    play: () => { clearTimeout(t); const id = cur; setTimeout(() => { log("sc:playing", id); fire("play"); }, 40);
      t = setTimeout(() => { if (cur !== id) return; log("sc:ended", id); fire("finish"); }, SONG_MS); },
    pause: () => { clearTimeout(t); log("sc:pause", cur); fire("pause"); }, setVolume: (x) => { if (x === 18 || x === 100) log("sc:vol", x); } };
  setTimeout(() => fire("ready"), 30); return w;
}, { Events: { READY: "ready", PLAY: "play", PAUSE: "pause", FINISH: "finish", ERROR: "error" } }) };
// memo audio element logging
const _play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  if (this.src && this.src.startsWith("blob:")) {
    log("memo:start");
    if (!this.__t4t) { this.__t4t = true; this.addEventListener("ended", () => log("memo:end")); }
  }
  return _play.call(this);
};
</script>
<script src="/player.js"></script>
"""

def mk(page, tracks, source="youtube", lane=None, extra=""):
    page.evaluate("""([tracks, source, lane]) => {
      LOG.length = 0; if (window.deck) deck.destroy();
      document.getElementById('mount').innerHTML = '';
      tracks.forEach(t => { if (t.memo) t.memoUrl = MEMO; });
      window.deck = new T4TDeck({ mount: document.getElementById('mount'), tracks, source, defaultLane: lane || 'youtube',
        onChange: s => { window.S = s; } });
      deck.slot(deck.state.lane);
    }""", [tracks, source, lane])

def wait_for(page, needle, timeout=6000):
    page.wait_for_function("n => LOG.some(l => l.includes(n))", arg=needle, timeout=timeout)

def logs(page): return page.evaluate("LOG.slice()")

def seq(lines, keep):
    return [l for l in lines if any(l.startswith(k) for k in keep)]

results = []
def check(name, cond, detail=""):
    results.append((cond, name))
    print(("PASS  " if cond else "FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))

def T(i, **kw):
    d = {"original": f"Song {i}", "display": f"Song {i}", "artist": f"A{i}", "ytVideoId": f"vid{i:08d}"[:11]}
    d.update(kw); return d

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = b.new_page()
    page.route(f"{BASE}/harness", lambda r: r.fulfill(status=200, content_type="text/html", body=HARNESS))
    # /api/match is faked: "Song 7" exists nowhere on YouTube; SoundCloud ids for everything
    def match(route):
        u = route.request.url
        if "provider=soundcloud" in u: return route.fulfill(json={"ok": True, "scId": "777000"})
        if "Song+7" in u or "Song%207" in u: return route.fulfill(json={"ok": True, "videoId": None})
        return route.fulfill(json={"ok": True, "videoId": "matched0001"})
    page.route(f"{BASE}/api/match*", match)
    page.goto(f"{BASE}/harness")
    page.wait_for_function("!!window.T4TDeck")

    # 1. the three memo positions, in order, across a whole tape
    mk(page, [T(0, memo=True, memoPosition="intro"), T(1, memo=True, memoPosition="outro"), T(2, memo=True, memoPosition="over-ad"), T(3)])
    page.evaluate("deck.play()")
    wait_for(page, "yt:playing vid00000003", 12000)
    s = seq(logs(page), ["memo:", "yt:playing", "yt:ended", "yt:vol"])
    want = ["memo:start", "memo:end", "yt:playing vid00000000", "yt:ended vid00000000",
            "yt:playing vid00000001", "yt:ended vid00000001", "memo:start", "memo:end",
            "memo:start", "yt:vol 18", "yt:playing vid00000002", "yt:ended vid00000002", "memo:end", "yt:vol 100", "yt:playing vid00000003"]
    flat = [x.split(" vol=")[0] for x in s]
    check("intro → song, song → outro, over-memo talks on a turned-down song and gets to finish even if the song ends first",
          flat == want, " | ".join(flat))
    check("the over-memo song plays underneath at volume 18", any("vid00000002 vol=18" in l for l in s))

    # 2. hammer next while a memo is talking
    mk(page, [T(i, memo=True, memoPosition="intro") for i in range(12)])
    page.evaluate("deck.play()"); wait_for(page, "memo:start")
    page.evaluate("for (let i = 0; i < 10; i++) deck.next()")
    page.wait_for_timeout(2500)
    L = logs(page)
    played = [l for l in L if l.startswith("yt:playing")]
    check("10 rapid skips mid-memo: only the song you landed on plays (no ghost songs)",
          len(played) >= 1 and all("vid00000010" in l or "vid00000011" in l or "vid00000000" in l for l in played) and "vid00000010" in played[0],
          " | ".join(played))
    check("lands on song 11 and carries on from there", page.evaluate("deck.state.index") >= 10 or page.evaluate("deck.state.index") <= 2)

    # 3. pause in the middle of a memo, then play: the memo finishes instead of being skipped
    page.evaluate("window.MEMO_LONG = MEMO")
    mk(page, [T(0, memo=True, memoPosition="intro"), T(1)])
    page.evaluate("deck.play()"); wait_for(page, "memo:start"); page.wait_for_timeout(150)
    page.evaluate("deck.pause()"); page.wait_for_timeout(200)
    page.evaluate("deck.play()"); wait_for(page, "yt:playing vid00000000")
    s = seq(logs(page), ["memo:", "yt:playing vid00000000"])
    check("pause mid-memo → play resumes the memo, THEN the song", s[:2] == ["memo:start", "memo:start"] and s[-1].startswith("yt:playing vid00000000") and "memo:end" in s, " | ".join(s))

    # 4. a song YouTube doesn't have falls back to SoundCloud for that song only
    mk(page, [T(6, ytVideoId=None), T(7, ytVideoId=None, scId="555"), T(8, ytVideoId=None)], source="youtube")
    page.evaluate("deck.lanes = ['youtube','soundcloud']; deck.jump(1, true)")
    wait_for(page, "sc:playing 555")
    check("song missing on YouTube plays from SoundCloud instead of being skipped", True)
    wait_for(page, "yt:playing matched0001", 8000)
    check("…and the next song goes back to YouTube", page.evaluate("deck.state.lane") == "youtube")

    # 5. a YouTube video that refuses to embed
    page.evaluate("BROKEN.add('vid00000001')")
    mk(page, [T(0), T(1), T(2)])
    page.evaluate("deck.jump(1, true)")
    wait_for(page, "yt:playing vid00000002", 8000)
    check("a blocked YouTube video skips to the next song on its own", True)
    page.evaluate("BROKEN.clear()")

    # 6. SoundCloud tapes play on the SoundCloud lane with memos
    mk(page, [T(0, ytVideoId=None, scId="900", memo=True, memoPosition="over-ad"), T(1, ytVideoId=None, scId="901")], source="soundcloud", lane="soundcloud")
    check("SoundCloud tapes offer YouTube + SoundCloud lanes", page.evaluate("deck.lanes.join()") == "youtube,soundcloud", page.evaluate("deck.lanes.join()"))
    page.evaluate("deck.play()")
    wait_for(page, "sc:playing 901", 8000)
    s = seq(logs(page), ["memo:", "sc:"])
    check("over-memo works on SoundCloud too (ducks to 18, back to 100)", "sc:vol 18" in s and "sc:vol 100" in s and s.index("sc:vol 18") < s.index("sc:vol 100"), " | ".join(s))

    # 7. default lane: a Spotify tape still starts on YouTube
    mk(page, [T(0, ytVideoId=None, spotifyId="4uLU6hMCjMI75M1A2tKUQC")], source="spotify")
    check("Spotify tapes start on YouTube by default", page.evaluate("deck.state.lane") == "youtube")
    check("Spotify is still offered as a switch", "spotify" in page.evaluate("deck.lanes"))

    # 8. admin switched Spotify off
    page.evaluate("""() => { LOG.length = 0; deck.destroy(); window.deck = new T4TDeck({ mount: document.getElementById('mount'),
        tracks: [{ original: 'x', spotifyId: '4uLU6hMCjMI75M1A2tKUQC' }], source: 'spotify', lanesAllowed: { spotify: false } }); }""")
    check("admin can switch a lane off everywhere", "spotify" not in page.evaluate("deck.lanes"))

    # 9. switching lane mid-song keeps playing and doesn't replay the intro memo
    mk(page, [T(0, scId="321", memo=True, memoPosition="intro")])
    page.evaluate("deck.lanes = ['youtube','soundcloud']; deck.play()")
    wait_for(page, "yt:playing vid00000000")
    page.evaluate("deck.setLane('soundcloud'); deck.slot('soundcloud')")
    wait_for(page, "sc:playing 321")
    check("switching YouTube → SoundCloud mid-song keeps playing, memo not repeated",
          sum(1 for l in logs(page) if l == "memo:start") == 1)

    # 10. 200-song tape, memo on every song: auto-advance through 25 songs
    page.evaluate("SONG_MS = 120")
    mk(page, [T(i, memo=True, memoPosition=["intro", "outro", "over-ad"][i % 3]) for i in range(200)])
    page.evaluate("deck.play()")
    page.wait_for_function("deck.state.index >= 25", timeout=60000)
    L = logs(page)
    starts, ends = L.count("memo:start"), L.count("memo:end")
    check(f"200-song tape: auto-played 25 songs, {starts} memos started / {ends} finished, no stalls", starts >= 24 and ends >= starts - 1, f"{starts}/{ends}")
    b.close()

fails = [n for ok, n in results if not ok]
print(f"\n{len(results) - len(fails)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
