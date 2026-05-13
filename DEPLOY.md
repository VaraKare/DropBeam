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

Recommended: **Fly.io**. It runs Bun natively, has a generous free
tier, and gives you a `*.fly.dev` HTTPS+WSS hostname automatically
(WebSockets included).

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
- [ ] Fly account + flyctl installed.
- [ ] `apps/signaling/Dockerfile` and `fly.toml` added.
- [ ] `fly launch --no-deploy && fly deploy` succeeded; `/healthz` returns ok.
- [ ] Vercel project linked to the GitHub repo, root dir `apps/web`.
- [ ] `VITE_SIGNALING_URL` set in Vercel to your Fly URL.
- [ ] First production transfer works on two devices.
