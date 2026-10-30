# T4T Mix on The People's 990

**Recommendation:** keep T4T Mix as its own app and show it on The People's 990 in an iframe. Don't merge the codebases. The People's 990 repo needs no changes beyond one page.

## How it works
- Every saved tape has an embed URL: `https://<T4T host>/embed/<tape-id>` (returned as `embedUrl` when a tape is saved).
- `/embed/*` sends `Content-Security-Policy: frame-ancestors 'self' <EMBED_ORIGINS>`, so only thepeoples990.com (and www) can frame it. This was tested: it loads on thepeoples990.com and the browser blocks it on any other site.
- To allow another site, add it to `EMBED_ORIGINS` in `wrangler.jsonc` and redeploy.

## Snippet (Hono route on The People's 990)
```ts
app.get("/listen", (c) => c.html(`
  <section class="listen">
    <h2>Now playing</h2>
    <p>A mixtape from the community, powered by T4T Mix.</p>
    <iframe
      src="https://t4tmix.queeraccountingsolutions.workers.dev/embed/TAPE_ID"
      title="T4T Mix player"
      width="390" height="720" loading="lazy"
      style="border:0;border-radius:16px;max-width:100%"
      allow="autoplay; encrypted-media; clipboard-write">
    </iframe>
  </section>`));
```
Replace `TAPE_ID` with a real tape id. If the site sets its own CSP, add the T4T host to `frame-src`.

## Things to think about first
- **Brand separation:** The People's 990 is a civic and nonprofit-finance site. Branding it "powered by" a Queer Accounting Solutions product mixes the two, which matters before the **Dec 15** fiscal-sponsor go/no-go. Suggestion: put it on a clearly separate page (a community or "Beyond the 990" page), not the homepage, and wait until after Dec 15.
- **Ads:** YouTube playback can show ads, and a civic site may not want that. Spotify playback doesn't, but full tracks need the listener to be logged in.
- **No autoplay:** the player waits for a tap. Keep it that way.
- **Better fit, maybe:** a T4T-style "tape" of short audio explainers about how to read a 990 could suit the mission better than music.
