# Deploying DropBeam to production

DropBeam has two pieces of infrastructure that need to run somewhere:

1. **The web app** (`apps/web/`) — a static Vite bundle. Loads in the
   browser, owns all the file-transfer logic.
2. **The signaling server** (`apps/signaling/`) — a Bun WebSocket server
   that introduces two peers to each other. Never sees file content,
   but must stay running for the duration of every transfer.

Vercel is perfect for the first one. **Vercel cannot host the second
one** — their serverless functions are HTTP-only and short-lived,
and the platform has no long-running WebSocket runtime.

So the production setup is:

```
   ┌──────────────────────┐       ┌──────────────────────┐
   │  apps/web (static)   │       │  apps/signaling      │
   │  → Vercel            │  ws   │  → Fly.io / Railway  │
   │  https://...vercel   │ ───▶  │  wss://...fly.dev/ws │
   └──────────────────────┘       └──────────────────────┘
```

Two separate deploys; the web app talks to the signaling host over
a single WebSocket. **Both are free at our usage tier.**

---

## Part 1 — Deploy the web app to Vercel

### 1a. Set up `vercel.json`

I've added one at `apps/web/vercel.json` (see "Vercel project config"
section below). It tells Vercel how to build the Vite app and which
SPA-fallback rewrites to apply.

### 1b. Connect the repo

```bash
# install once
npm i -g vercel

# from the repo root
vercel link
```

Pick:
- **Set up and deploy?** → Yes
- **Scope** → your personal account
- **Link to existing project?** → No
- **Project name** → `dropbeam` (or whatever)
- **Code directory** → `./apps/web`
- **Override settings?** → No (the `vercel.json` will be picked up)

That records a `.vercel/` folder locally.

### 1c. Or do it from the dashboard (easier)

1. Go to <https://vercel.com/new>.
2. Import the `VaraKare/DropBeam` repo.
3. **Framework Preset:** Vite.
4. **Root Directory:** `apps/web`.
5. **Build Command:** leave Vercel's default (`vite build`) or set to
   `bun install --cwd ../.. && bun --cwd ../.. run build:web`.
6. **Output Directory:** `dist`.
7. **Install Command:** `bun install` (Vercel detects `bun.lock`).
8. **Environment Variables:** add `VITE_SIGNALING_URL` →
   `wss://your-signaling-host.fly.dev/ws` (you'll fill this in after
   Part 2 below; you can redeploy to update it).

Click **Deploy**. ~30 seconds later you have an HTTPS URL.

### 1d. Custom domain

Vercel project → Settings → Domains. Add your domain (e.g.
`dropbeam.example.com`) and add the CNAME they show you to your DNS.

---

## Part 2 — Deploy the signaling server

Three paths, all valid. **Pick Koyeb first** (free, no sleep, dashboard-only).
If you've burned your Render free slot or want CLI control, the alternatives
follow.

### Path A — Koyeb (recommended: free, no sleep, dashboard)

Free tier: one always-on web service with 512 MB RAM, custom HTTPS+WSS
hostname, auto-deploy from GitHub. **No sleep, no card.**

1. Sign up at <https://app.koyeb.com> (GitHub OAuth — fastest).
2. Click **Create Service** → pick **GitHub** as source.
3. Select the `VaraKare/DropBeam` repo, branch **main**.
4. **Build & deployment**:
   - Builder: **Dockerfile**
   - Dockerfile location: **`apps/signaling/Dockerfile`**
   - Build context: **`.`** (the repo root, NOT `apps/signaling/`)
5. **Service type**: Web Service.
6. **Ports**: add one — port **8787**, protocol **HTTP**, path **`/`**, public.
   Koyeb proxies WebSocket over HTTPS automatically; no extra setting needed.
7. **Health checks**: HTTP, path `/healthz`, port 8787.
8. **Environment variables**: leave defaults. (Optionally set
   `ROOM_CAPACITY=8`, `MAX_ROOMS=10000`.)
9. **Region**: pick the one closest to your users (Frankfurt / Washington /
   Singapore). Free tier is one region.
10. **Instance**: **Free** plan, **Nano** instance.
11. Click **Deploy**. First build takes ~4 min.
12. You'll get a URL like `https://dropbeam-signaling-<you>.koyeb.app`.
    The WebSocket endpoint is `wss://dropbeam-signaling-<you>.koyeb.app/ws`.
13. Sanity check:
    ```bash
    curl https://dropbeam-signaling-<you>.koyeb.app/healthz
    # → {"ok":true,"rooms":0,"uptimeMs":...}
    ```

That's it. No keep-alive ping needed — Koyeb free instances don't sleep.

### Path B — Render (only if you have a free slot)

Render Free is capped at **one** free web service per account. If you've
already used yours on something else, Render will ask you to upgrade — go
back to Path A (Koyeb). If your free slot is available, the repo ships
`render.yaml` for one-click Blueprint deploy.

1. <https://dashboard.render.com> → **New → Blueprint** → pick the repo
   → **Apply**.
2. Wait ~3 min for the build.
3. Service URL appears at the top; WebSocket is `wss://<that>/ws`.
4. **Keep-alive (important):** Render Free sleeps after 15 min of idle.
   Sign up free at <https://uptimerobot.com>, add an HTTP monitor on
   `<your-url>/healthz` with 5-minute interval. Keeps it warm 24/7.

### Path C — Fly.io (CLI, $5/mo free credit, always-on)

For when you want CLI control and CDN-edge regions. Fly removed the
always-free tier but gives every account a $5/mo credit that comfortably
covers a small Bun service.

```bash
brew install flyctl
fly auth login
```

Add a `fly.toml` at the repo root:

```toml
app = "dropbeam-signaling"   # change to your unique name
primary_region = "iad"       # sjc / ams / fra / sin / blr — pick closest

[build]
  dockerfile = "apps/signaling/Dockerfile"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
```

Then:

```bash
fly launch --no-deploy
fly deploy
# → wss://dropbeam-signaling.fly.dev/ws
```

### 2a. Install flyctl

```bash
brew install flyctl       # macOS
fly auth signup            # creates account if needed
fly auth login
```

### 2b. Create a `Dockerfile` for the signaling app

Save this as `apps/signaling/Dockerfile`:

```dockerfile
FROM oven/bun:1.1-alpine
WORKDIR /app

# Copy the workspace package files first for cache-friendly installs.
COPY package.json bun.lock ./
COPY packages/protocol ./packages/protocol
COPY apps/signaling/package.json ./apps/signaling/

# Install only production deps for the signaling package.
RUN bun install --frozen-lockfile --production

# Copy source last so code changes don't bust the install cache.
COPY apps/signaling ./apps/signaling

EXPOSE 8787
CMD ["bun", "apps/signaling/src/server.ts"]
```

### 2c. Create `fly.toml` at the repo root

```toml
app = "dropbeam-signaling"  # change to your unique name
primary_region = "iad"      # closest to your users (sjc, ams, fra, sin, etc.)

[build]
  dockerfile = "apps/signaling/Dockerfile"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"   # keep alive for long transfers
  auto_start_machines = true
  min_machines_running = 1
```

> **Why `PORT=8080`?** Fly's edge proxy expects internal apps on 8080
> by default. The signaling server already reads `process.env.PORT`,
> so this Just Works.

### 2d. Launch

```bash
fly launch --no-deploy        # creates the app; uses your fly.toml
fly deploy
```

You'll get a hostname like `https://dropbeam-signaling.fly.dev`. The
WebSocket endpoint is `wss://dropbeam-signaling.fly.dev/ws`.

### 2e. Sanity check

```bash
curl https://dropbeam-signaling.fly.dev/healthz
# → {"ok":true,"rooms":0,"uptimeMs":...}
```

### 2f. Wire the Vercel app to it

Back on Vercel → Project Settings → Environment Variables:

| Variable                  | Value                                          |
|---------------------------|------------------------------------------------|
| `VITE_SIGNALING_URL`      | `wss://dropbeam-signaling.fly.dev/ws`          |

Hit **Redeploy**. Done. Open the Vercel URL and it'll connect through
the Fly signaling host.

---

## Vercel project config (drop in `apps/web/vercel.json`)

```json
{
  "buildCommand": "vite build",
  "outputDirectory": "dist",
  "rewrites": [
    { "source": "/((?!assets|.*\\.(?:svg|js|css|map|webmanifest|ico|png|jpg|woff2?)).*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/sw.js",
      "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
    },
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    }
  ]
}
```

The rewrites send every non-asset path back to `index.html` so the
SPA's deep-link routing (`?c=K7-9P3-MX2A`) works after a hard refresh.
The headers make the service worker always fresh and the hashed assets
cacheable forever.

---

## Other hosting choices for signaling

If you don't want Fly.io, any of these work — they all support
long-running WebSocket servers:

| Host         | Pros                                        | Notes                                  |
|--------------|---------------------------------------------|----------------------------------------|
| **Fly.io**   | Best Bun support; generous free tier        | Recommended above                      |
| **Railway**  | Easiest UI; one-click deploy from GitHub    | Generates `*.up.railway.app` HTTPS     |
| **Render**   | Auto-deploy on git push                     | Web service type; free tier sleeps     |
| **Cloud Run**| Scales to zero; cheap                       | Bun container, set `--port 8787`       |
| **VPS**      | Total control                               | Caddy / nginx in front for TLS         |

**Do not** try to put signaling on Vercel Functions, Cloudflare
Pages Functions, or Netlify — none of them support the kind of
persistent WebSocket connection a signaling server needs.

(Cloudflare Workers + Durable Objects *could* host signaling, but
it's a significant rewrite — they don't speak the same API.)

---

## Optional: TURN server for "Anywhere" mode reliability

Without a TURN server, the public deploy works for ~80 % of users.
The other 20 % sit behind symmetric NATs (hotel Wi-Fi, corporate
networks, some mobile carriers) and need TURN to relay bytes.

Free options:
- **Twilio Network Traversal Service** — pay-as-you-go ($0.40 / GB).
- **metered.ca** — free 50 GB/month.
- **Self-hosted coturn** on the same Fly.io machine.

Once you have credentials, update the ICE servers in
`apps/web/src/main.ts`:

```ts
const iceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:your-turn-host:3478",
    username: "user",
    credential: "pass",
  },
];
```

---

## Quick deploy checklist

- [ ] `apps/web/vercel.json` added.
- [ ] Signaling deployed (Koyeb / Render / Fly); `/healthz` returns ok.
- [ ] Vercel project linked to the GitHub repo, root dir `apps/web`.
- [ ] `VITE_SIGNALING_URL` set in Vercel to your signaling host's `wss://…/ws`.
- [ ] First production transfer works on two devices.

---

## Vercel via CLI (alternative to the dashboard)

If you'd rather not click through Vercel's dashboard, the CLI does the
same thing in three commands. Useful when you want to script deploys or
keep both deploys reproducible.

```bash
# 1. Install + auth (one-time)
npm i -g vercel
vercel login           # opens a browser to authenticate

# 2. From the repo root, link the project
cd apps/web
vercel link
#   ? Set up "apps/web"?          Yes
#   ? Which scope?                <your-personal-account>
#   ? Link to existing project?   No
#   ? What's your project's name? dropbeam
#   ? Code directory?             ./ (already in apps/web)
#   ? Override settings?          No

# 3. Set the env var pointing at your signaling host
vercel env add VITE_SIGNALING_URL production
#   When prompted, paste: wss://<your-signaling-host>/ws

# 4. Deploy to production
vercel deploy --prod
#   → https://dropbeam-<hash>.vercel.app
```

Subsequent deploys are just `vercel deploy --prod` from `apps/web/`. Or
let Vercel auto-deploy from GitHub pushes (the default when you link the
GitHub repo from the dashboard).

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
