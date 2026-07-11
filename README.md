# FEELD Browser Bridge

<img width="1318" height="656" alt="Screenshot 2026-07-10 at 5 39 02 PM" src="https://github.com/user-attachments/assets/c437a134-fa86-437d-b775-95816828115a" />

A small local web interface that mirrors your connected Android device's screen in a desktop browser and forwards manual taps, swipes, long-presses, text, and hardware-button events through Android Debug Bridge (ADB).

It was built around the **official Feeld Android app**, but it operates at the OS input/display level rather than inside any single app, so it mirrors and controls whatever is in the foreground on the device. Feeld is only special-cased in one place: the **Open Feeld** button, which launches a configurable package name (`FEELD_PACKAGE`).

It does **not** call Feeld's private API, scrape profiles, automate likes/messages, bypass authentication, or store screenshots. Every action on the phone is the direct result of a single explicit click in the browser; there is no bot loop, no scheduler, and no batching of actions.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Run](#run)
- [Controls](#controls)
- [Multiple Android devices](#multiple-android-devices)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Security notes](#security-notes)
- [Use via SSH](#use-via-ssh)
- [Privacy and appropriate use](#privacy-and-appropriate-use)
- [Development](#development)

## How it works

```
 Browser (public/index.html)                  Node server (server.js)                Android device
┌──────────────────────────┐   EventSource   ┌───────────────────────┐   adb    ┌──────────────────┐
│ <img id="frame">         │ <────────────── │ /api/events (SSE)     │ ───────> │ screencap -p      │
│  tap / swipe / long-press│ ── fetch POST ─>│ /api/tap, /api/swipe, │ ───────> │ input tap/swipe/  │
│  hardware buttons        │                 │ /api/key, /api/type   │          │ keyevent/text     │
└──────────────────────────┘                 └───────────────────────┘          └──────────────────┘
```

- A background loop calls `adb exec-out screencap -p` on an interval (`FRAME_INTERVAL_MS`, default 450ms, minimum 250ms), downsamples the PNG to a JPEG (max width 900px) with `sharp`, and keeps only the **latest** frame in memory. Nothing is written to disk.
- The device connection (`adb devices`) is only re-verified periodically (every 3s) or immediately after an error, not on every single frame capture, to keep ADB overhead low.
- The browser holds a persistent `EventSource` connection to `/api/events`. The server pushes a status payload over Server-Sent Events every time a new frame is captured or an error occurs, instead of the browser polling blindly. The browser only re-fetches `/api/frame.jpg` when the pushed `frameVersion` actually changes.
- Every pointer/keyboard action in the browser becomes exactly one `adb shell input ...` call. Coordinates are translated from on-screen pixels back to the device's real resolution before being sent.

## Requirements

- Node.js 20 or newer
- Android Platform Tools (`adb`)
- An Android phone with USB debugging enabled, or an Android Studio emulator
- Feeld installed and logged in on that device, if you intend to use the **Open Feeld** shortcut (the screen mirroring and tap/swipe/key controls work with whatever app is in the foreground, not just Feeld)

## Setup

### macOS

```bash
brew install node android-platform-tools
```

### Linux

```bash
sudo apt install android-tools-adb   # Debian/Ubuntu
# or your distro's equivalent package for `adb`
```

### Windows

Install Node.js, then install [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools) and add the extracted folder to your `PATH` so `adb` is available in a terminal.

### Physical device (any OS)

1. Enable **Developer options** on the phone (tap the Build number 7 times in Settings → About phone).
2. Enable **USB debugging** inside Developer options.
3. Connect the phone by USB.
4. Accept the RSA-key authorization prompt that appears on the phone.

Confirm the connection:

```bash
adb devices
```

The device should appear with the status `device`, not `unauthorized` or `offline`.

## Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:4173
```

Click **Open Feeld**. Click the mirrored screen to tap, click-and-drag to swipe, or press and hold to send a long-press (useful for context menus and drag-to-select).

## Controls

| Action | How | Sent to device |
| --- | --- | --- |
| Tap | Click on the screen | `input tap x y` |
| Swipe | Click, drag, release | `input swipe x1 y1 x2 y2 duration` |
| Long-press | Press and hold ~450ms without moving | `input swipe x y x y 550` (same start/end point) |
| Type | Focus a field on the phone, type in the sidebar box, click **Type** or press Enter | `input text ...` |
| Back / Home / Recent apps | Buttons | `input keyevent KEYCODE_BACK` / `HOME` / `APP_SWITCH` |
| Enter / Backspace | Buttons | `KEYCODE_ENTER` / `KEYCODE_DEL` |
| Lock screen / Wake screen | Buttons | `KEYCODE_POWER` / `KEYCODE_WAKEUP` |
| Volume up / down | Buttons | `KEYCODE_VOLUME_UP` / `KEYCODE_VOLUME_DOWN` |
| Open Feeld | Button | `monkey -p <package> -c android.intent.category.LAUNCHER 1` |

Typed text is limited to 500 characters of basic ASCII per request. `input text` on Android does not reliably support emoji or many non-ASCII characters, so use the phone's on-screen keyboard for those.

## Multiple Android devices

When more than one device or emulator is connected, choose one explicitly:

```bash
adb devices
ADB_SERIAL=emulator-5554 npm start
```

Starting the server without `ADB_SERIAL` while multiple devices are attached will fail fast with an explicit error rather than guessing which device to control.

## Configuration

All configuration is via environment variables; there is no config file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Keep this local; see [Security notes](#security-notes). |
| `PORT` | `4173` | Port to listen on. |
| `ADB_SERIAL` | *(none)* | Target a specific device/emulator when more than one is connected. |
| `FRAME_INTERVAL_MS` | `450` | Screencap polling interval in milliseconds. Clamped to a minimum of `250`. Lower values increase responsiveness at the cost of more ADB/CPU load. |
| `FEELD_PACKAGE` | `co.feeld` | Android package name launched by the **Open Feeld** button. |

Example:

```bash
PORT=4173 \
HOST=127.0.0.1 \
ADB_SERIAL=emulator-5554 \
FRAME_INTERVAL_MS=450 \
FEELD_PACKAGE=co.feeld \
npm start
```

## API reference

The server only exposes these local endpoints; there is no external network call anywhere in the code.

| Method & path | Body | Description |
| --- | --- | --- |
| `GET /api/status` | *(none)* | One-shot JSON snapshot: `ok`, `serial`, `package`, `sourceWidth`, `sourceHeight`, `frameVersion`, `lastFrameAt`, `error`. |
| `GET /api/events` | *(none)* | Server-Sent Events stream. Pushes the same payload as `/api/status` whenever it changes. |
| `GET /api/frame.jpg?v=` | *(none)* | Latest captured JPEG frame. `v` is a cache-busting frame version, not authentication. |
| `POST /api/tap` | `{ x, y }` | Tap at device-resolution coordinates (clamped to the screen bounds). |
| `POST /api/swipe` | `{ x1, y1, x2, y2, duration? }` | Swipe between two points. `duration` is clamped to 80-1500ms (default 280ms). |
| `POST /api/key` | `{ key }` | One of `BACK`, `HOME`, `APP_SWITCH`, `ENTER`, `DEL`, `TAB`, `POWER`, `VOLUME_UP`, `VOLUME_DOWN`. |
| `POST /api/type` | `{ text }` | Basic ASCII text, 500 characters max, sent to the currently focused field. |
| `POST /api/open-feeld` | *(none)* | Launches `FEELD_PACKAGE` via `monkey`. |
| `POST /api/wake` | *(none)* | Sends `KEYCODE_WAKEUP`. |

All endpoints return `{ error: string }` with a non-2xx status on failure (e.g. no device connected, invalid coordinates).

## Troubleshooting

- **"No authorized Android device or emulator is connected."** Run `adb devices`. If nothing is listed, check the USB cable/connection. If it says `unauthorized`, unlock the phone and accept the debugging prompt.
- **"More than one Android device is connected."** Set `ADB_SERIAL` to the one you want (see [Multiple Android devices](#multiple-android-devices)).
- **Screen appears black or frozen.** Some apps mark their window `FLAG_SECURE`, which blocks `screencap` from capturing it; this bridge cannot override that. Confirm the phone screen isn't simply locked or asleep, or try **Wake screen**.
- **`command not found: adb`.** ADB isn't on your `PATH`. Reinstall Android Platform Tools or add its folder to `PATH`.
- **Port already in use.** Another process is bound to `4173`; set `PORT` to a different value.
- **Typed text looks garbled or fails.** `input text` only supports basic ASCII; punctuation like quotes or backticks is escaped automatically, but emoji and most non-Latin scripts are not supported. Use the phone's own keyboard for those.
- **Status badge stuck on "Reconnecting…".** The `EventSource` connection dropped (e.g. the server restarted). It reconnects automatically; refresh the page if it doesn't recover within a few seconds.

## Limitations

- The screen refresh rate is intentionally modest; this is a lightweight remote, not video streaming.
- ADB text entry supports basic ASCII most reliably. Use the Android on-screen keyboard for emoji or unusual characters.
- Some Android apps can mark windows as secure. If Feeld ever enables that protection, screenshots may appear black and this bridge cannot override it.
- Purchases, account verification, location permission, camera access, and biometrics still happen inside the official Android app.
- App updates can change the Android package name or behavior.

## Security notes

- **Keep `HOST=127.0.0.1`.** Binding to `0.0.0.0` (or any non-loopback interface) would expose your live phone screen and full tap/swipe/type control to anything else on the same network, with no authentication in front of it.
- There is no login, token, or CSRF protection by design. This is meant to be a single-user, single-machine tool; see [Use via SSH](#use-via-ssh) if you need to reach it from another device.
- The server only shells out to a fixed `adb` binary with argument arrays (`execFile`, never a shell string), so request bodies cannot inject arbitrary shell commands. Even so, treat the local port as equivalent to physical access to the unlocked phone.
- Frames are kept in memory only (`latestFrame` buffer) and are overwritten every capture cycle; nothing is persisted to disk by this server.

## Use via SSH

The server only binds to `127.0.0.1` and has no authentication, so the supported way to use it from a machine other than the one running `adb` is an SSH tunnel, not opening the port on the network.

On the machine with the Android device attached:

```bash
npm start
```

From the other machine, forward a local port to the server's loopback port over SSH:

```bash
ssh -L 4173:127.0.0.1:4173 user@host-running-the-server
```

Then open `http://127.0.0.1:4173` in a browser on the machine you ran `ssh` from. Traffic (including the mirrored screen and every tap/swipe/keystroke) is encrypted inside the SSH tunnel; nothing is exposed on the network beyond standard SSH access to that host.

Notes:

- You need SSH access to the host running the server; this doesn't add any new authentication to the bridge itself, it reuses your existing SSH login.
- Close the tunnel (`Ctrl+C` on the `ssh` command, or kill the session) when you're done; the forwarded port stops working immediately.
- If you also want to reach it from a phone or tablet on the same Wi-Fi without SSH, use your SSH client's port-forwarding feature (e.g. Termius) rather than setting `HOST=0.0.0.0` on the server.

## Privacy and appropriate use

Use this only for your own account and personal device. Do not add profile collection, bulk actions, automatic swiping, message automation, or API reverse engineering. The server is local-only by default and keeps only the latest compressed frame in memory.

## Development

```bash
npm install
npm run check   # node --check server.js (syntax validation only, no test suite)
npm start
```

There is no build step or bundler. `server.js` is plain ESM run directly by Node, and `public/index.html` is a single static file with inline CSS/JS served as-is.

## Author 
Michael  Mendy (c) 2026.
