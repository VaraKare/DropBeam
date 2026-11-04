# DropBeam: product, market and growth plan

> **One line:** open a web page on both devices, type a short code, and the
> file goes straight from one to the other. Any size, any device, no app,
> no account, and nothing stored in the middle.

---

## 1. The problem we solve

Moving a file between your own devices, or to someone next to you, is still
annoying in 2026:

| Pain | Who feels it |
|---|---|
| AirDrop only works Apple ↔ Apple | Anyone with an iPhone + Windows laptop, or an Android + Mac |
| WhatsApp/Telegram shrink photos and videos and cap file size | Creators, photographers, students |
| Google Drive / WeTransfer upload everything to a server first, then download it again: twice the time, plus size limits, accounts and ads | Anyone sending big videos |
| Email caps at ~25 MB | Everyone |
| USB cables and pen drives get lost, carry viruses, or the port doesn't match | Offices, labs, family |
| Many office/college PCs **don't allow installing apps** | Students, employees |
| "Is my file sitting on someone's server?" | Lawyers, doctors, HR, privacy-minded people |

DropBeam fixes all of these with one web page.

---

## 2. Who uses it, and for what

| User | Typical use |
|---|---|
| **Everyday people** | Phone photos → laptop without cables; iPhone ↔ Windows; sending a video to a family member's phone in the same room |
| **Students** | Move assignments from a lab PC (no installs allowed) to their phone; share project files in a group |
| **Creators / editors** | Send 4K raw footage from phone to editing laptop at full quality, no compression |
| **Small offices** | Share files between colleagues without a shared drive or IT setup |
| **Developers / IT** | Move builds, logs or disk images between machines; self-host on a LAN |
| **Privacy-sensitive work** | Contracts, medical scans, ID documents: files never rest on a third-party server |
| **Events, classrooms** | Speaker → projector laptop; teacher → students (multi-receiver is on the roadmap) |
| **Offline / remote places** | Self-hosted on a LAN (ships, field sites, labs): works with no internet at all |

---

## 3. Comparison with the big names

How they work, in short. Competitor plans change, so re-check limits before
quoting them publicly.

| | DropBeam | AirDrop | Quick Share (Google) | WeTransfer | Google Drive link | Snapdrop / PairDrop | FilePizza | Wormhole.app | Send Anywhere | LocalSend |
|---|---|---|---|---|---|---|---|---|---|---|
| Install needed | **No** (browser) | Built into Apple | Built into Android / app on Windows | No (web) | No (web) | No (browser) | No (browser) | No (browser) | App or web | **Yes**, app |
| Account | **No** | Apple ID | Google account | No to send (limits) | **Yes** | No | No | No | No (optional) | No |
| Works across brands | **All** | Apple only | Mostly Android/Windows | All | All | All | All | All | All | All |
| Works over the internet (not just nearby) | **Yes** | No | No | Yes | Yes | Same network (PairDrop: also paired) | Yes | Yes | Yes | No (LAN) |
| Files stored on a server | **Never** | No | No | Yes (days) | Yes (until deleted) | No | No | Yes, encrypted, ≤24 h | Depends on mode | No |
| Size limit | **None** (disk/browser storage) | None | None | Free plan: a few GB | Your Drive quota | Browser memory on some | None | Limited when stored | Limited in link mode | None |
| Verifies every file (SHA-256) | **Yes** | – | – | – | – | No | No | – | – | – |
| Resumes after interruption | **Yes** | No | No | Upload yes | Yes | No | No | – | – | No |
| Recipient can be offline | No (both online) | No | No | **Yes** | **Yes** | No | No | **Yes** | Yes (link mode) | No |
| Discovers nearby devices | Not yet | **Yes** | **Yes** | – | – | **Yes** | No | No | Yes | **Yes** |
| Open source / self-host | **Yes, MIT** | No | No | No | No | Yes | Yes | No | No | Yes |

### Where DropBeam wins

1. **No install + works over the internet + any size**, all at once. Most
   tools give you two of the three.
2. **Verified delivery.** Every file is hash-checked after it lands. Almost
   nobody else promises "the file you got is bit-for-bit the file I sent."
3. **Resume** for huge files on shaky connections.
4. **No server copy.** Nothing to leak, nothing to subpoena, no storage bill.
5. **Self-hostable**, including fully offline on a LAN.

### Where DropBeam loses today, and the plan

| Weakness | Plan |
|---|---|
| Both devices must be online at the same time | "Leave it for later" option (ROADMAP §3 #10), opt-in |
| No automatic nearby-device discovery | Nearby devices (ROADMAP §3 #5) |
| Phones receiving huge files are limited by browser storage and by iOS pausing background tabs | Clear warnings already exist; later, a native wrapper |
| Unknown brand | §6 growth plan |
| Some strict networks need TURN, which costs money | Measure the TURN share; use cheap TURN; Pro tier |

**Positioning line:** *"AirDrop for every device, over the internet, with
nothing stored in the cloud."*

---

## 4. What it costs to run

The architecture is cheap on purpose. **File bytes don't touch our
servers**, except through TURN.

Prices below are approximate, as of 2026. Check current pricing before
paying.

| Item | Free option | Paid option | Notes |
|---|---|---|---|
| Domain | – | ~$10–15/yr (.com) | `dropbeam.com`, `.io`, `.net` and `.dev` showed as available on 2026-11-04 (`.app` was taken). Check at the registrar. |
| Website hosting | **Vercel Hobby, free, but non-commercial use only** | Vercel Pro ~$20/mo | ⚠ **Ads count as commercial use.** Hobby is fine while there are no ads. When ads go on, either pay for Pro or move to **Cloudflare Pages (free, commercial use allowed)**. The app is static, so moving takes ~10 minutes. |
| Signaling server | Render free (sleeps after 15 min idle; keep warm with an UptimeRobot ping) | Render Starter ~$7/mo (never sleeps) | One small instance handles a lot (ROADMAP §4) |
| Uptime monitoring | UptimeRobot free | – | |
| TURN relay | Small free tiers exist (e.g. Metered); Cloudflare TURN is pay-per-GB | ~$0.05–0.40 per relayed GB depending on provider | **The only cost that grows with usage.** Typically ~10–20% of internet connections need TURN. |
| Storage (S3/R2) | **Not needed** | R2 ~$0.015/GB-month, free egress | Only for the optional "leave it for later" feature |
| Email for abuse/contact | Free forwarding (Cloudflare Email Routing / registrar) | – | Needed for AdSense and app stores |

**Day-one budget: about $12/year (just the domain).** Everything else can
start on free tiers.

---

## 5. Making money

### Ads: realistic numbers

A file-transfer page is a **utility**. People arrive, transfer, leave, and
don't browse. So:

- About **1.5–2 pageviews per visit**.
- Ad RPM (earnings per 1,000 pageviews) for utility sites is roughly
  **$0.50–3** globally. India-heavy traffic sits at the low end.
- **30–40% of tech-savvy users block ads.**

| Monthly visitors | Pageviews | Ad revenue / month (rough) |
|---|---|---|
| 1,000 | ~2,000 | $1–5 |
| 10,000 | ~20,000 | $10–50 |
| 100,000 | ~200,000 | $100–500 |
| 1,000,000 | ~2,000,000 | $1,000–5,000 |

### ⚠ Ads vs. our privacy promise

Today the README and Privacy page say **"no cookies, no analytics."** Google
AdSense uses cookies and tracking. To add AdSense you'd have to:

1. Change the privacy page honestly.
2. Show a cookie-consent banner to EU/UK visitors (required).
3. Keep ad scripts **away from the transfer screens**. Ad code runs inside
   the page and could read file names. Put ads only on the home/landing,
   done and blog pages, and lock everything else down with a
   Content-Security-Policy.

**Better fits for this product:**

| Option | Why it fits |
|---|---|
| **EthicalAds / Carbon Ads** | One tasteful, privacy-friendly ad (no tracking cookies), aimed at developers. Lower volume, but matches the brand |
| **Donations** (GitHub Sponsors, Buy Me a Coffee, UPI) | Works well for open-source utilities with a clear mission, like the 30% donation pledge |
| **DropBeam Pro** (~$3–5/mo) | Bigger TURN allowance, "leave it for later" storage, custom code words, multi-receiver, no ads |
| **Teams / self-host support** | Schools and offices pay for a private instance + setup help |
| **Sponsors** | A TURN/hosting company sponsoring "bandwidth by X" |

**Suggested mix:** launch with donations + one EthicalAds-style slot, keep
the privacy promise, and add Pro once TURN costs show up. Use AdSense only on
the blog/landing pages if you need it.

---

## 6. Growth estimate and plan

These are estimates, not promises. They assume steady work on the roadmap
and one launch push.

| Stage | Time (rough) | Monthly users | Monthly cost | Monthly income | Do this |
|---|---|---|---|---|---|
| **0. Launch** | Month 0–1 | 100–1,000 | ~$1 (domain) | $0 | Domain, deploy, manual test matrix, Terms + abuse email |
| **1. First fans** | Month 1–6 | 1k–20k | $0–10 | $5–60 | Show HN, Product Hunt, Reddit (r/selfhosted, r/opensource, r/webdev, r/iphone, r/india), short demo reels ("iPhone → Windows in 10 s, no app") |
| **2. Search traffic** | Month 6–12 | 20k–100k | $10–60 (Render Starter + TURN + maybe Vercel Pro) | $50–400 | Blog/SEO pages: "AirDrop for Windows", "send large files free no signup", "iPhone to PC without iTunes"; Android share target; accept/decline; folders |
| **3. Product-market fit** | Year 2 | 100k–1M | $60–600 (TURN dominates) | $400–5k (ads + Pro + donations) | Pro tier, short-lived TURN credentials, multi-region signaling, i18n |
| **4. Scale** | Year 3+ | 1M+ | Grows with TURN usage | Pro/Teams lead | Self-host bundle for schools/offices, partnerships |

### What decides success

1. **Reliability on the first try.** One failed transfer loses a user forever.
   Run the test checklist (ROADMAP §2a) before launch.
2. **The TURN share.** If 10% of transfers relay, costs stay tiny; at 40%
   they don't. Measure it from day one.
3. **Search ranking for "how do I send X to Y"** queries. That's where the
   steady, free traffic comes from.
4. **The share loop.** Every transfer puts DropBeam in front of a second
   person (the receiver). A subtle "Sent with DropBeam, free, no app" on the
   done screen turns receivers into senders.

### Launch checklist (non-technical)

- [ ] Buy the domain and set it up (Vercel + `ws.` sub-domain for Render)
- [ ] Logo/OG image for link previews
- [ ] 30-second demo video (phone ↔ laptop)
- [ ] Privacy + Terms + contact email live
- [ ] Post: Show HN → Product Hunt (Tue–Thu) → Reddit → LinkedIn/Instagram reel
- [ ] Ask the first 50 users "what almost stopped you?" and fix that first
