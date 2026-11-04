# Deploying DropBeam to production

DropBeam has two deployable pieces:

```
  Browser A ──── https ────▶  Vercel (static web app, apps/web)
      │
      └──── wss ───────────▶  Signaling server (Bun WebSocket, apps/signaling)
                               on Koyeb / Render / Fly — NOT Vercel
  Browser A ◀══ WebRTC P2P (files) ══▶ Browser B
```

Vercel can't host the signaling server: it needs a long-lived WebSocket,
which Vercel / Netlify / Cloudflare Pages functions don't support. **Deploy
signaling first**, then point the web app at it.

---

## Step 1 — Deploy the signaling server

The repo ships `apps/signaling/Dockerfile` (build context = repo root) and a
`render.yaml` blueprint. Any Docker host works.

### Option A — Koyeb (free, doesn't sleep)

1. <https://app.koyeb.com> → **Create Service** → **GitHub** → this repo, branch `main`.
2. Builder **Dockerfile**, location `apps/signaling/Dockerfile`, build context `.` (repo root).
3. Port **8787**, protocol HTTP, public. Health check: HTTP `/healthz` on 8787.
4. Free plan, Nano instance → **Deploy** (~4 min).
5. WebSocket URL: `wss://<service>.koyeb.app/ws`.

### Option B — Render (free, sleeps after 15 min idle)

1. <https://dashboard.render.com> → **New → Blueprint** → pick this repo → **Apply**.
2. WebSocket URL: `wss://<service>.onrender.com/ws`.
3. Free instances sleep when idle, and the first connection after that takes
   ~30–60 s. Add a free <https://uptimerobot.com> HTTP monitor on
   `https://<service>.onrender.com/healthz` every 5 min to keep it warm.

### Check it

```bash
curl https://<your-signaling-host>/healthz
# → {"ok":true,"rooms":0,...}
```

---

## Step 2 — Deploy the web app to Vercel

Everything is configured in the **root** `vercel.json` (install with Bun,
build `apps/web`, serve `apps/web/dist`, SPA rewrites, cache headers).

1. <https://vercel.com/new> → import this repo.
2. **Root Directory: leave it as the repo root** (`./`). Don't set it to
   `apps/web` — the build needs the workspace packages.
3. Framework preset: Vite. Leave build/output settings alone (they come from `vercel.json`).
4. **Environment Variables** (Production + Preview):

   | Name | Required | Example |
   |---|---|---|
   | `VITE_SIGNALING_URL` | **yes** | `wss://<your-signaling-host>/ws` |
   | `VITE_TURN_URLS` | no | `turn:turn.example.com:3478,turns:turn.example.com:5349` |
   | `VITE_TURN_USERNAME` | no | from your TURN provider |
   | `VITE_TURN_CREDENTIAL` | no | from your TURN provider |

   `VITE_*` values are baked in **at build time**. After changing them,
   redeploy.
5. **Deploy.**

If `VITE_SIGNALING_URL` is missing or uses `ws://`, the deployed page shows a
red banner explaining what to fix instead of failing silently.

CLI alternative:

```bash
npm i -g vercel && vercel login
vercel link                                   # from the repo root
vercel env add VITE_SIGNALING_URL production  # paste wss://…/ws
vercel deploy --prod
```

---

## Optional — TURN relay for "Anywhere" mode

Without TURN, devices connect directly via STUN, which works on most home
and mobile networks. Strict NATs (corporate Wi-Fi, some hotels and carriers)
need a TURN relay. Files are still DTLS-encrypted end to end through it.

Options: Metered.ca (free tier, needs an account), Cloudflare Realtime TURN,
Twilio NTS, or self-hosted coturn. Put the URLs and credentials in the
`VITE_TURN_*` variables above and redeploy.

Note: TURN credentials in a static site are visible to anyone who opens
DevTools. Use a provider that lets you cap usage, or short-lived credentials.

---

## Local / LAN-only mode (no internet needed)

```bash
bun run lan     # builds the web app and serves it from the signaling server
```

Open `http://<your-LAN-IP>:8787` on both devices. Same-origin signaling is
detected automatically, so no env vars are needed.

---

## Deploy checklist

- [ ] Signaling deployed; `/healthz` returns `{"ok":true,…}`.
- [ ] Vercel project imported with Root Directory = repo root.
- [ ] `VITE_SIGNALING_URL=wss://…/ws` set, then redeployed.
- [ ] Open the site: no red banner; header pill says "Internet mode".
- [ ] Send a file between two devices on different networks.

---

## SEO — sitemap, Open Graph image, Search Console

The repo ships everything needed for Google + Bing to index DropBeam
well, including the per-route titles, descriptions, JSON-LD structured
data, sitemap, and a social-card image. There are two manual steps
you do once before launch.

### 1 — Convert the OG image to PNG

`apps/web/public/og.svg` is the editable source (1200×630, the
social-card design). Twitter/LinkedIn don't render SVG previews —
they need a PNG at the same path:

```bash
# one-time tool install
brew install librsvg

# convert
rsvg-convert -w 1200 -h 630 apps/web/public/og.svg > apps/web/public/og.png

# commit the rendered file
git add apps/web/public/og.png
git commit -m "build: render og.png from og.svg"
git push
```

After the next Vercel deploy, paste your URL into Twitter's card
validator (<https://cards-dev.twitter.com/validator>) and Facebook's
sharing debugger (<https://developers.facebook.com/tools/debug/>) to
make sure they pick up the card.

### 2 — Submit the sitemap to Google Search Console

`apps/web/public/sitemap.xml` lists `/`, `/about`, `/features`,
`/privacy`, `/terms`. The Vercel rewrites in `vercel.json` make all
five real URLs (each loads the SPA and `main.ts` swaps the document
title + meta description to the right values, so Google sees five
distinct pages — that's how you earn sitelinks under your main result).

After deploying to Vercel:

1. Open <https://search.google.com/search-console>.
2. **Add Property** → URL prefix → paste your Vercel URL (or custom
   domain when you have one).
3. Verify via the DNS TXT record method (or the easier HTML tag method
   if you're on a Vercel domain).
4. In the left nav: **Sitemaps** → enter `sitemap.xml` → **Submit**.
5. Wait 1–3 days. Google will start indexing all five routes. Sitelinks
   appear automatically once Google has enough data and clicks to
   trust the site structure (usually weeks-to-months after launch).

Bonus for Bing: do the same at <https://www.bing.com/webmasters>.
Bing's market share is small but the indexing is much faster (~hours).

### 3 — When you get a custom domain

Update these three files in one PR:

| File | Change |
|------|--------|
| `apps/web/index.html` | `<link rel="canonical" href="...">` → your domain |
| `apps/web/public/sitemap.xml` | replace relative `<loc>` paths with absolute `https://yourdomain/...` |
| `apps/web/public/robots.txt` | `Sitemap: https://yourdomain/sitemap.xml` |

Then re-submit the sitemap in Search Console.

---

## Running ads (the honest version)

The codebase ships an `<div class="ad-slot">` in `apps/web/index.html`
that's `display: none` by default. **Read this before you flip it on.**

DropBeam's privacy posture is the product's biggest differentiator
("zero tracking, zero analytics, we cannot see your files"). Any
third-party ad SDK — Google AdSense, Carbon Ads, etc. — sets cookies
and pings their servers when the page loads. That's tracking.

If you ship ads, **be honest about it:**

1. Update `apps/web/src/main.ts` → `PRIVACY_HTML` to disclose the ad
   provider, what data they collect, and a link to their privacy policy.
2. Add a one-line cookie consent banner if you target users in the EU
   (UK GDPR / ePrivacy require it).
3. Consider keeping ads on a separate marketing page (`/about`, blog
   posts) and never on the transfer surface itself. Many transfer
   apps that "respect your files" still run ads on their landing page —
   it's a defensible line.

A privacy-friendlier alternative: **EthicalAds** or **Carbon Ads** —
both serve un-targeted ads with no cookies. Lower revenue but matches
the brand.

To enable:

```css
/* apps/web/src/styles.css */
.ad-slot { display: block; }   /* was: none */
```

Then paste your provider's script tag inside the `<div class="ad-slot">`
element in `index.html`.
