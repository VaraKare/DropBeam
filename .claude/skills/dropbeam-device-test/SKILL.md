---
name: dropbeam-device-test
description: Run a real-device test round for DropBeam (phones, tablets, Windows laptops, admin-locked university PCs, different networks) and record the results. Use when the user has devices available, asks to "test on my phone", or before a launch or release that changes transfer behaviour.
---

# dropbeam-device-test

Claude can't hold the phone. This skill turns the user's devices into a short, recorded test round.

## 1. Ask what's available today (one AskUserQuestion, multiSelect)

iPhone/iPad Safari · Android Chrome · Windows laptop (Chrome/Edge/Firefox) · Mac Safari · admin-locked
university/office PC · lab laptops · second network (mobile data / campus Wi-Fi / a friend's home).
Note anything that's unavailable as "untested" in the report, so it can be planned later. Never guess a result.

## 2. Pick the matrix slice

Use docs/ROADMAP.md §2a (the 7 rows × small/medium/large) and only the rows these devices allow.
Always include, when possible:

- **Admin-locked PC** (no installs, possibly old browser, strict firewall/proxy): open the site, send to a
  phone and receive from a phone. This is the core "works where you can't install anything" claim, so note
  the browser version, whether the folder picker is blocked, and which network mode worked.
- **Different networks** (laptop on Wi-Fi ↔ phone on mobile data): tells us how often TURN would be needed.
- **iPhone receiving** a medium file, plus phone-lock mid-transfer behaviour.

Plus the scenario list under the matrix (QR scan, wrong code, expiry, passphrase, cancel+resume, Wi-Fi off,
tab close, same name twice, too-big file, PWA install).

## 3. Guide the round

Use the live site unless the user wants staging/local (for local over LAN: `bun run lan`, but phones need
HTTPS for many features, so prefer the deployed site). Give one test at a time: what to do on device A,
what to do on device B, what to look for. Ask the user for ✔/✖ plus a screenshot or error text on failure.
Keep messages short, because the user is juggling devices.

## 4. Record

Write `docs/audit/YYYY-MM-DD-device-matrix.md`:
- Devices (model, OS, browser + version), networks
- Matrix table with ✔ / ✖ / untested
- Failures: steps, what was seen, screenshot path, suspected cause
- "Not tested yet" list (devices or networks we lacked)

Then, for each ✖, propose a fix: do it here when it's small, or propose a session for it.
