# Nigel's Walking Pad -- Mobile (Android PWA)

## Why this isn't just a copy of the desktop app

The Windows app talks to the pad using `bleak` (a Python Bluetooth
library) and shows its window with `pywebview`. Neither runs on
Android. This folder is a rewrite of the same functionality as a
**Progressive Web App (PWA)** -- a website that runs Bluetooth
directly in the phone's browser via the **Web Bluetooth API**, and
that you "install" to your home screen so it opens full-screen like
a normal app. No Play Store listing, no APK build (I also can't build
an Android APK in this environment -- there's no Android SDK here).

Chrome for Android and Samsung Internet (6.2+) both support Web
Bluetooth, so this will work in either browser on your S23.

## What's in here

- `index.html` -- main control screen: connect, start/stop, speed
  chips, live stats, today + recent days, video panel
- `dashboard.html` -- full charts and day-by-day history
- `protocol.js` -- JS port of `fitshow_protocol.py` (same frame
  format, same commands, same open questions -- e.g. the `0xab` auth
  handshake still isn't reverse-engineered, and this still skips it,
  same as the desktop app)
- `app.js` -- Web Bluetooth connect/control logic + session tracking
- `manifest.webmanifest`, `service-worker.js`, `icon.svg` -- make it
  installable to your home screen and usable offline
- `activity_history_backup.json` -- your existing history from
  `activity_history.json`, ready to import (see below)

## One important difference: where history is stored

The desktop app writes to a file (`activity_history.json`) next to
the app. A phone browser can't write to an arbitrary file like that,
so this version stores your history in the browser's **localStorage**
instead -- tied to that browser, on that phone. Two things follow
from that:

- **Bring your old history over**: open the dashboard, tap **Import
  backup**, and select `activity_history_backup.json` (included in
  this folder) to load your existing sessions.
- **Back it up occasionally**: tap **Export backup** on the dashboard
  now and then, especially before clearing browser data or switching
  phones -- clearing Chrome's site data for this page would otherwise
  erase your history.

## Deploying it to your phone

Web Bluetooth only works in a "secure context" (HTTPS, or
`localhost`) -- **not** when you open `index.html` straight from a
file on your phone. The simplest free option:

1. Create a free GitHub repository (or reuse one you have) and upload
   all the files in this folder to it.
2. Turn on **GitHub Pages** for that repo (Settings -> Pages -> Deploy
   from branch -> `main` / root). GitHub gives you a URL like
   `https://yourname.github.io/walkingpad/`.
3. Open that URL in Chrome on your S23.
4. Tap the **three-dot menu -> Add to Home screen** (Chrome) or the
   equivalent in Samsung Internet. It'll now open full-screen from an
   icon like a normal app.

Any other static host works too (Netlify Drop, Cloudflare Pages,
etc.) -- the only requirement is HTTPS.

## Bluetooth connection: one real unknown to flag

The desktop app (via `bleak`) can freely list *every* Bluetooth
service on the pad and search all of them for the `ffe1`/`fff1`
characteristics. Web Bluetooth, for privacy reasons, requires the
**service UUID** to be named up front before it'll let a page look at
it -- it won't do a free-for-all scan like `bleak` does.

Since the original capture didn't record the pad's actual service
UUID, `app.js` tries a handful of common guesses first (the usual
128-bit expansions of `ffe0`/`fff0`/`ff00`/`ffb0`, which is where
these characteristics live on most BLE fitness-pad modules). If
Connect can't find the characteristics with those guesses, there's a
troubleshooting panel on the main screen where you can paste in the
real service UUID(s), comma-separated. You can find the correct one
in a couple of minutes with a free BLE scanner app like **nRF
Connect** (Play Store): connect to the pad there, open its service
list, and copy the UUID of whichever service contains `ffe1`.

I haven't been able to test any of this against your actual pad (I
don't have access to the hardware), so this connection step is the
most likely thing to need a tweak on the first real attempt -- if it
doesn't connect first try, the activity log at the bottom of the
screen and the troubleshooting field are there for exactly that.

## Voice control

Tap **Voice: Off** (top bar) to turn it on -- it'll ask for microphone
permission the first time. Recognized phrases:

- "start" / "stop" (or "pause")
- "faster" / "speed up", "slower" / "slow down" (±0.5 km/h)
- "speed five" / "speed five point five" -- sets an exact km/h
- "programme one" / "programme two" -- starts that preset by number
- "stop programme" / "cancel programme"

This uses the browser's built-in `SpeechRecognition` (Web Speech API),
which streams audio to Google's recognition service to work -- it's
not on-device, so it needs a data connection. Support on Android is
real but has historically been a bit inconsistent between Chrome
versions and OEM browsers, so if it doesn't respond, the button will
say **"Voice unsupported"** and the on-screen buttons/chips still work
exactly the same either way -- voice is additive, not a replacement.

## Programmes -- all 25, with spoken encouragement

`programmes.js` now has all 25 programmes, transcribed from the
programmes array already built into your updated `index.html`. Each
runs as a sequence of speed/duration segments -- the player sets
speed at the start of each segment, counts down, advances, and stops
at the end -- startable from the **Programmes** card or by voice
("programme one" through "programme twenty five").

At each new segment (after the first) it speaks a short line of
encouragement plus the segment name and target speed -- e.g. *"Great
work! Keep up the momentum. Now starting Stage 2 at 6.3 kilometers
per hour."* -- using the same rotating set of lines as the desktop
app. It also announces the programme starting and finishing.

**About the "male voice":** this uses the browser's built-in
`SpeechSynthesis`, not a specific named voice file -- it looks
through whatever voices Android/Chrome has installed and picks the
first one that looks like an English male voice (matching "Male",
"George", "Oliver", "Daniel", or "UK English" in its name), falling
back to any `en-GB` voice, then any voice at all. Which voices are
actually available depends on your phone's installed TTS voice
packs, so the specific voice you hear may differ slightly from your
Windows machine -- if you want a particular one, check **Settings ->
General management -> Text-to-speech** on the S23 for which voices
are installed, and you can ask me to hardcode the match to a
specific voice name if you tell me which one shows up there.

## Pause, and live programme info -- now matching the desktop app

Two things from your desktop `index.html` that hadn't made it across yet:

- **Pause button**: there's now a three-button row (Start / Pause /
  Stop). Pause sets speed to 0 and remembers your speed so Resume can
  restore it, speaks "Walking pad paused." / "Resuming workout.", and
  -- if a programme is running -- freezes its countdown while paused
  (same as the desktop version's `isPaused` check) rather than letting
  it keep counting down with the belt stopped.
- **Live programme display**: while a programme is running, a
  prominent dark info box appears above the speed readout showing the
  programme name, the current step ("Step 3/7: Peak Training (6.4
  km/h)"), and a large countdown for that step -- the same layout and
  purpose as `programInfoBox` / `programTitleLine` / `programStepLine`
  / `programTimeLine` in your desktop version. A **Cancel programme**
  button sits inside that box.

## Screen stays awake mid-walk

Also ported: the desktop app's wake-lock behaviour, so your S23's
screen won't lock itself while you're mid-programme. It re-requests
the lock automatically if the tab regains focus after the screen was
off for another reason.

## Everything else carried over from the desktop app

- Frame format, checksums, and all six commands (`query_info`,
  `query_status`, `poll`, `start`, `stop`, `set_speed`) -- byte-for-byte
  identical to `fitshow_protocol.py`
- Speed/time/distance/calories parsing from the poll replies
- No step count (the pad doesn't report one, per the original README)
- No incline control (this unit's incline is fixed)
- YouTube video panel, remembers the last video loaded
