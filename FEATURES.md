# DropBeam: features

> Send any file to any device from the browser. No account, no upload server,
> and every file is verified on arrival.

## Works in any modern browser

| Browser | Send | Receive |
|---|---|---|
| Chrome / Edge (computer) | ✅ | ✅ Straight into a folder you choose, or into browser storage then Save |
| Safari (Mac) | ✅ | ✅ Browser storage, then Save |
| Firefox | ✅ | ✅ Browser storage, then Save |
| iPhone / iPad Safari | ✅ | ✅ Browser storage, then Share → Save to Files |
| Android Chrome | ✅ | ✅ Browser storage, then Save. QR scan with the camera |

Receiving needs the page on `https://` (or `localhost`).

## Pairing

- A short code (e.g. `K7-9P3-MX2A`), case- and dash-insensitive.
- A QR code and a direct link (`/?c=CODE`) that opens the receive screen
  pre-filled.
- Copy code, copy link, and the device's native Share sheet.
- The code expires after 30 minutes, with one-tap **Get a new code**.

## Two connection modes

- **Same Wi-Fi:** only local network addresses are used, so files never leave
  your network. The first handshake still reaches the signaling server, unless
  you self-host on the LAN.
- **Anywhere:** STUN finds a direct path through home routers. An optional TURN
  relay covers strict networks; the bytes stay DTLS-encrypted through it.
- A live badge shows the actual path: LAN-direct, P2P-direct or TURN relayed.

## Big files

- The sender streams from disk, so memory stays flat at any size.
- Chrome/Edge with a chosen folder write straight to disk.
- Browser-storage receiving checks free space **before** starting and refuses
  cleanly if it won't fit.
- Warnings at 2 GB and 10 GB, and a keep-awake reminder when the estimate is
  over 10 minutes. The screen wake lock is held during transfers.
- **Resume:** if a transfer is interrupted, send the same files again and it
  continues from the last complete byte.

## Integrity and safety

- The receiver re-reads every file and checks its SHA-256 against the
  sender's. A mismatch deletes the file and fails both sides with a clear
  message.
- Downloads go to `name.<size>.dbpart` first and are renamed when complete.
  Existing files are never overwritten (`photo (1).jpg`).
- Sender file names are sanitized, so they can't escape the chosen folder.
- Optional passphrase: AES-GCM-256 per chunk, key from PBKDF2 (200k
  iterations). A wrong passphrase is reported as such on both sides.

## Clear feedback

- A connection stepper: Connecting → Secure link → Transferring → Verified.
- Overall progress, speed and estimated time left, plus per-file progress
  bars and "verifying %".
- Plain-language errors (wrong code, peer left, network blocks P2P, not
  enough space, wrong passphrase) with **Try again**.
- A red banner if the deployment is misconfigured.

## Privacy

- No accounts, no cookies, no analytics. The signaling server never sees file
  contents.
- Recent transfers (names and sizes) are kept only on your device, with a
  Clear button.
- Files held in browser storage are deleted on Clear or after 24 hours.

## App-like

- Installable as an app (PWA). The app shell is cached, so it loads instantly
  on repeat visits.
- Drag-and-drop, paste, or click to choose files. Remove files from the list
  before sending.
- Works at phone width with no sideways scrolling.

## Not built yet

- Sending whole folders (with their structure).
- An accept/decline prompt on the receiver before bytes flow.
- "Devices near me" discovery.
- Native apps (earlier experiments are on the `archive/native` branch).
