# DropBeam — feature catalog

A complete inventory of what DropBeam does, organized by where the feature
surfaces. Use this as the source of truth when building marketing pages,
blog posts, mobile screens, or onboarding flows.

---

## 1. The headline promise

> **Send any file to any device. Phone to laptop, Mac to Windows, Android to
> iPad, in any direction. Files stream peer-to-peer, end-to-end encrypted,
> with no upload server holding them.**

### What that lets you do

- Move a 50 GB video from your phone to your editing rig without paying for
  cloud storage or waiting for upload.
- Drop a folder from a Windows desktop into a Mac at a coffee shop with no
  internet — both phones on the cafe Wi-Fi is enough.
- Hand a contract to a colleague on the other side of the world without it
  ever touching Dropbox or WeTransfer.

---

## 2. Cross-platform reach

Anything that runs a modern browser is a DropBeam node. No app to install.

| Platform        | Sender | Receiver | Notes                                              |
|-----------------|:------:|:--------:|----------------------------------------------------|
| Chrome / Edge   |  ✅   |   ✅    | Full features (File System Access, BarcodeDetector) |
| Safari 16+      |  ✅   |   ✅    | Falls back to downloads folder (no `showDirectoryPicker`) |
| Firefox         |  ✅   |   ✅    | Same as Safari                                     |
| iOS Safari 16+  |  ✅   |   ✅    | Receive uses downloads; camera scan via input fallback |
| Android Chrome  |  ✅   |   ✅    | Full QR camera scan via `BarcodeDetector`          |
| Windows 10/11   |  ✅   |   ✅    | Any browser                                        |
| macOS           |  ✅   |   ✅    | Any browser                                        |
| Linux           |  ✅   |   ✅    | Any browser                                        |

The same code path runs on every device — there's no Phone↔Windows vs
Android↔Mac distinction. It's just "browser ↔ browser."

---

## 3. Two connection modes

DropBeam auto-detects the right mode and lets you override it.

### Same Wi-Fi mode — no internet needed

- Both devices on one router. ICE uses only `host` candidates (private LAN
  IPs). The WebRTC data channel goes directly over the LAN.
- No STUN servers, no public traffic, no metered data.
- Works on planes, in hotels, at conferences, in basements — any place
  where "Wi-Fi" exists but "internet" doesn't.
- The signaling server can run on one of the devices (or any LAN box) via
  `bun run lan`, so the URL `http://192.168.x.y:8787/` is the *only*
  thing that needs to be reachable.

### Anywhere mode — across the internet

- STUN servers help peers discover their public addresses and hole-punch
  through NATs.
- If both peers are behind symmetric NATs, a TURN relay forwards
  end-to-end encrypted bytes.
- Even relayed bytes stay encrypted — the relay can't read them.

### Live transport indicator

During an active transfer the UI shows which path actually got picked:

- `LAN-direct · no internet` — host candidates connected on the LAN.
- `P2P-direct · encrypted` — STUN-assisted direct hole-punch.
- `TURN relayed · encrypted` — bytes flow through a relay (still E2E).

---

## 4. Pairing options

The sender always gets two ways to share:

### A. The short code

`K7-9P3-MX2A` — easy to read out loud, type, or text. Case-insensitive,
strips spaces and dashes. 9 alphabet chars (~45 bits entropy), ephemeral
(default 30 minute TTL).

### B. The QR code

A scannable QR encoding a deep-link URL: `https://yoursite/?c=K7-9P3-MX2A`.
The receiver either:

- **Scans with the camera** — Chrome on Android uses the native
  `BarcodeDetector` API. The code auto-fills.
- **Opens the link** — taps the URL, lands on the page with the code
  pre-filled, hits "Join."
- **Types it in manually** — fallback that always works.

### C. Native Web Share

On supported devices, a "Share…" button hooks into the OS share sheet
(iMessage, AirDrop, WhatsApp, Mail, etc.) so the sender can send the
join link with one tap.

---

## 5. End-to-end encryption (always)

- **Layer 1 — DTLS** (built into WebRTC): every byte that leaves the
  device is encrypted by the browser. The signaling server only sees
  opaque SDP/ICE blobs; it cannot decrypt the data channel.
- **Layer 2 (optional) — AES-GCM-256**: tick the passphrase box and
  every chunk gets re-encrypted with a key derived in-browser via
  PBKDF2 (200,000 iterations). The receiver must enter the same
  passphrase to decrypt. Even our signaling server can't help you
  recover this — we don't have it.

### What's *not* encrypted

- The short share code is in plaintext at the signaling server (it
  has to be — that's how peers find each other). Codes expire fast and
  carry no payload info; you should treat them like Wi-Fi passwords.

---

## 6. Large-file streaming

- **No size limit** — DropBeam was tested with files in the tens of
  gigabytes. The implementation reads/writes by chunk and never holds
  the whole file in memory.
- **Direct-to-disk receive** (Chrome/Edge) — the File System Access
  API lets the worker stream incoming chunks straight to disk; RAM
  usage stays at ~50 MB regardless of file size.
- **Worker-based pipeline** — chunking, hashing (SHA-256), encryption,
  and framing happen in a Web Worker, so the UI stays responsive
  during a 30-minute transfer.
- **Backpressure-aware** — uses WebRTC's `bufferedAmountLow` event to
  pace sending. Won't OOM either side.
- **Per-file SHA-256 verification** — the receiver hashes each file
  as it arrives; corruption is caught at file boundaries, not at the
  end of a 50 GB upload.

---

## 7. Mobile-aware reliability

The web app actively defends against the things that break mobile
transfers in other tools:

- **Wake Lock during transfer** — requests the Screen Wake Lock API
  so the phone doesn't lock and suspend the tab mid-transfer.
- **`beforeunload` warning** — if you try to navigate away or close
  the tab during an active transfer, the browser warns you.
- **Visibility re-acquisition** — if the OS pauses the tab, the wake
  lock is re-requested as soon as the page becomes visible again.
- **No label-wrapped file inputs** — bypasses an iOS Safari quirk
  where tapping a `<label for="…">` and returning from the picker can
  unload the page. We use a `<button>` that calls `input.click()`.
- **Touch-optimized targets** — every interactive element is at least
  44×44 px on phones (Apple HIG).
- **Mobile-first layout** — single-column on phones; share code wraps
  before the QR; QR sits up top where the camera-paired flow puts it.

---

## 8. Progressive Web App (PWA)

- **Installable** to the home screen on iOS / Android / desktop. After
  install, the icon launches DropBeam in a standalone window.
- **Offline app shell** — service worker caches the HTML, CSS, JS,
  manifest, and icons. Once you've visited the page, it loads on a
  LAN with no internet.
- **Custom install button** — `beforeinstallprompt` is captured and a
  branded "Install" chip appears in the header where supported.

---

## 9. Privacy posture

- **Zero accounts.** No login, no email, no profile.
- **Zero file storage.** No bytes from your transfer ever touch our
  servers.
- **Zero analytics.** No Google, no Mixpanel, no Sentry. The page
  loads, runs, and exits.
- **Minimal local state.** `localStorage` holds:
  - A random `deviceId` (for the receiver's "from: iPhone · Chrome" label).
  - Your chosen connection mode (LAN vs Anywhere).
- **MIT-licensed source.** Anyone can audit, fork, or self-host.

See `apps/web/` → footer → "Privacy" for the user-facing statement.

---

## 10. Power-user features

For developers, security researchers, and people on locked-down networks.

### CLI

```bash
dropbeam send --signaling ws://... ./big.iso
dropbeam recv --signaling ws://... --out ./downloads
dropbeam send --quic --host 192.168.1.42 --port 9898 --token abc ./file
```

- Pure Node/Bun, no GUI.
- Same wire format as the browser, so a Mac CLI can send to an
  Android browser.
- Optional QUIC binary (`dropbeam-quic`, Rust/quinn) for sub-millisecond
  zero-RTT LAN transfers.
- Optional resume-by-id for restartable transfers.

### Self-hosting

```bash
git clone https://github.com/<you>/DropBeam
cd DropBeam && bun install
bun run lan       # builds the web app, runs everything on port 8787
```

A single Bun process serves the static web bundle and the WebSocket
signaling server on the same port. Drop this on a Raspberry Pi and
your whole household has private file sharing forever.

### Deep-link auto-join

URLs of the form `?c=K7-9P3-MX2A` jump straight to the receive flow
with the code pre-filled. Great for QR codes, deep links from chat
apps, and NFC tag payloads.

---

## 11. What's deliberately out of scope (for now)

Honesty so users know what to expect.

- **No native mobile apps yet.** The PWA is the mobile story today.
  The `apps/ios/` and `apps/android/` directories are wired-up stubs
  for future native apps; they don't ship as binaries yet.
- **No public TURN server.** "Anywhere" mode uses Google STUN; if
  your NAT requires TURN, you'll need to wire one in via the
  `iceServers` config.
- **No federated discovery.** You have to share a code or QR; there's
  no "Find devices near me" pane (yet). The desktop app has mDNS
  discovery on the LAN.
- **No replay / resume across browser restarts.** A reload kills the
  in-flight transfer. The `beforeunload` warning is your safety net.

---

## 12. Quick feature checklist

For a marketing page or release-notes section, pick from these
one-line bullets:

- 🛰  **Direct, peer-to-peer.** No upload server.
- 🔐 **End-to-end encrypted** in transit; optional AES-GCM-256 on top.
- 📡 **Same-Wi-Fi mode** that works with no internet.
- 🌍 **Anywhere mode** that punches through NATs.
- ∞  **No size limit.** Streams from disk.
- 📱 **QR + camera scan** for one-tap mobile pairing.
- 🔗 **Deep-link URLs.** Send a link, the page auto-joins.
- 🪟 **Cross-platform.** Browser-only. iOS, Android, Mac, Windows,
   Linux, ChromeOS.
- 🎯 **Live transport badge.** Know whether you're on LAN, P2P, or relay.
- 💤 **Wake Lock + reload warnings.** Mobile-safe.
- 🧰 **Open source, MIT.** Self-host the whole stack.
- 🚫 **Zero accounts. Zero analytics. Zero cookies.**
