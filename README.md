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

- `index.html` -- the entire app: connect, start/pause/stop, speed
  chips, live stats, today + recent days, the programme picker
  (an in-page overlay -- see below), and the video panel
- `dashboard.html` -- full charts and day-by-day history
- `protocol.js` -- JS port of `fitshow_protocol.py` (same frame
  format, same commands, same open questions -- e.g. the `0xab` auth
  handshake still isn't reverse-engineered, and this still skips it,
  same as the desktop app)
- `programmes.js` -- all 25 preset programmes' segment data
- `app.js` -- Web Bluetooth connect/control logic, session tracking,
  the programme player, voice control, and watch control
- `manifest.webmanifest`, `service-worker.js`, `icon.svg` -- make it
  installable to your home screen and usable offline
- `activity_history_backup.json` -- your original history from the
  desktop app, ready to import (see below)

## One important difference: where history is stored

The desktop app writes to a file (`activity_history.json`) next to
the app. A phone browser can't write to an arbitrary file like that,
so this version stores your history in the browser's **localStorage**
instead -- tied to that browser, on that phone.

- **Bring your old history over**: open the dashboard, tap **Import
  backup**, and select `activity_history_backup.json` to load your
  existing sessions.
- **Back it up occasionally**: tap **Export backup** on the dashboard
  now and then -- clearing Chrome's site data for this page would
  otherwise erase your history.

## Deploying it to your phone

Web Bluetooth only works in a "secure context" (HTTPS, or
`localhost`) -- not from a plain file on your phone. Push all these
files to a free static host (GitHub Pages, Netlify Drop, Cloudflare
Pages -- anything with HTTPS), open that URL in Chrome on your S23,
then **three-dot menu -> Add to Home screen** so it opens full-screen
like a normal app.

## Bluetooth connection: one real unknown to flag

The desktop app (via `bleak`) can freely list *every* Bluetooth
service on the pad. Web Bluetooth, for privacy reasons, requires the
**service UUID** to be named up front -- it won't do a free-for-all
scan like `bleak` does. Since the original capture didn't record the
pad's actual service UUID, `app.js` tries a handful of common guesses
(the usual 128-bit expansions of `ffe0`/`fff0`/`ff00`/`ffb0`, common
on this family of BLE fitness modules). If Connect can't find the
characteristics with those guesses, use the **Connection
troubleshooting** panel on the main screen to paste in the real
service UUID(s) -- found in a couple of minutes with a free scanner
app like **nRF Connect** (Play Store): connect to the pad there, open
its service list, and copy the UUID of whichever service contains
`ffe1`. I can't test this against your actual pad, so this is the
most likely thing to need a tweak.

## Fix (this update): every programme disconnected the pad

You were right that the separate programmes page was the cause -- but
the mechanism is a Bluetooth one, not a UI one. **A Web Bluetooth
connection lives only inside the JavaScript context of the page that
opened it.** Tapping a programme used to do `location.href =
'index.html'` -- a full page navigation -- which destroys that
JavaScript context completely. There's no such thing as a Bluetooth
connection that survives a page load, so the pad was silently dropped
the instant you tapped a programme, before the new page had even
finished loading. That's why *every* programme triggered it while
manual Start/Stop on the main screen never did.

**Fixed properly this time**: the programme list is now an overlay
*inside* `index.html` -- shown and hidden with CSS, never navigated
to. Tapping "Browse all 25 programmes" slides it over the current
screen; tapping a programme hides it and starts it directly in the
same script, so the connection is never touched. `programmes.html` has
been removed from the app entirely.

Two smaller things from the previous round are still in place and
still worth having regardless:

- **Serialized writes**: Start, Stop, set-speed, and the background
  poll all funnel through one queue that waits for each write to
  settle before the next goes out, since overlapping GATT writes is a
  separate, real cause of Android BLE disconnects.
- **Auto-reconnect**: if the pad drops the connection on its own
  (not from you pressing Disconnect), the app retries up to 4 times
  and resumes a running programme at the same step and speed.
- **A connection guard**: starting a programme while not connected
  now stops immediately with an on-screen alert instead of silently
  trying and failing.

If it *still* disconnects after this, that would point away from the
page-navigation bug and toward something else (weak signal, the pad's
own quirks, or the service-UUID guess being wrong in a way that causes
an unstable rather than a failed connection) -- send me the activity
log from the **Connection troubleshooting** panel if so.

## If a fix doesn't seem to take effect

The service worker now caches "network-first" -- every load fetches
the latest deployed files first, falling back to the cached copy only
if there's no signal. After deploying an update, fully close the app
(swipe it away from recent apps) and reopen it once, so the old
service worker hands off to the new one.

## Fix: "Today" figures not syncing with the pad

"Today" was only ever counting *completed* sessions already saved to
history. While a walk is in progress, the live Time/Distance/Calories
cards at the top update in step with the pad, but "Today" further down
stayed frozen at whatever it was before you started -- only catching
up once you pressed Stop. That's the desync.

Fixed two ways:

1. "Today" now adds in whatever walk is currently in progress, live,
   on top of the completed sessions already saved -- not just after
   you stop.
2. It refreshes on every single update from the pad (same cadence as
   the live stat cards) instead of on a separate 5-second timer, so it
   moves in step rather than catching up in occasional jumps.

## Fix: "totally wrong" time/distance/calories stats

Every stat the app shows was already sourced directly from the pad's
own telemetry (the `time_seconds`/`distance_m`/`calories` fields in
its status replies) -- nothing was being calculated independently.
What was missing was any sanity-checking on that data before saving
it, which is inherited straight from the desktop app's logic. Your
own `activity_history_backup.json` already had the evidence: five
sessions claiming average speeds of 20-95 km/h (physically impossible
on this pad -- your programmes only go up to 7.5 km/h) and one
zero-distance ten-second entry, all quietly saved as real walks
because nothing ever checked them. A handful of those in your history
is enough to badly skew a "Today" or all-time total.

Two changes:

1. **Going forward**, a session only gets saved if it's at least 8
   seconds long and its average speed is under 15 km/h. Anything
   outside that gets discarded with a note in the activity log
   explaining why, rather than silently polluting your history.
2. **For what's already there**, the dashboard has a new **Clean up
   bad entries** button. It scans your saved history against the same
   thresholds, shows you exactly what it wants to remove before doing
   anything, and only deletes after you confirm. Export a backup first
   if you want to keep a copy of the untouched history.

## Fix: bleeping / video stutter while voice control was on

Two separate things were compounding each other here:

1. **Android's own "listening started" tone.** Chrome for Android
   doesn't actually honour `continuous: true` reliably -- it silently
   ends speech recognition every few seconds of quiet, and the app was
   restarting it *instantly* every time that happened. Each restart
   re-claims the microphone, which plays Android's own short tone and
   briefly interrupts whatever else is using audio (your video). Instant,
   repeated restarts turned that into a near-constant bleep. Fixed by
   waiting ~0.7s between restarts instead of firing immediately -- this
   won't eliminate the tone entirely (it's the OS playing it, not
   something a web page can suppress), but it cuts it down from a loop
   to an occasional blip, and gives the video's audio a chance to
   recover between interruptions instead of stuttering continuously.

2. **A genuinely tiny silent audio file.** The **Watch** feature keeps a
   silent audio loop going so your phone treats the page as "media" the
   watch can control. That file turned out to be about 0.045
   *milliseconds* long -- looping many thousands of times a second,
   which is a real source of glitching on its own. Replaced it with a
   proper half-second silent clip.

If you still hear anything after this, it'll help to know whether
**Watch** mode was also switched on at the time -- that's a third
concurrent audio source (video + mic + watch's silent loop), and
turning it off while you're just using Voice + video is a reasonable
thing to try in isolation to narrow it down further.

## Programme progress now sits above the video player

The live programme info box (name, current step, countdown) used to
sit at the very top of the page, above the speed readout -- so
watching it while a YouTube video played meant scrolling back and
forth. It's now positioned directly above the **Watch while you walk**
card instead, so scrolling down to your video keeps your programme
progress in view right alongside it. It still only appears while a
programme is actually running (same as before) -- just in a different
spot in the page.

## Voice control

Tap **Voice: Off** (top bar) to turn it on -- it'll ask for microphone
permission the first time. Recognized phrases:

- "start" / "stop" (or "pause")
- "faster" / "speed up", "slower" / "slow down" (±0.5 km/h)
- "speed five" / "speed five point five" -- sets an exact km/h
- "programme one" through "programme twenty five" -- starts that preset
- "stop programme" / "cancel programme"

This uses the browser's built-in `SpeechRecognition`, which streams
audio to Google's recognition service to work (needs a data
connection). Support on Android is real but has historically been
inconsistent between Chrome versions and OEM browsers -- if it doesn't
respond, the button says **"Voice unsupported"** and every on-screen
control still works exactly the same either way.

## Programmes -- all 25, with spoken encouragement

`programmes.js` has all 25 programmes, transcribed from the programmes
array in your desktop `index.html`. Each runs as a sequence of
speed/duration segments, startable from the in-page **Programmes**
overlay or by voice.

At each new segment it speaks a short line of encouragement plus the
segment name and target speed -- e.g. *"Great work! Keep up the
momentum. Now starting Stage 2 at 6.3 kilometers per hour."* -- and
announces the programme starting and finishing.

**About the "male voice"**: this uses the browser's built-in
`SpeechSynthesis`, not a specific voice file -- it picks the first
installed voice that looks like an English male voice (matching
"Male", "George", "Oliver", "Daniel", or "UK English"), falling back
to any `en-GB` voice, then any voice at all. Which voices are actually
available depends on your phone's installed TTS packs (**Settings ->
General management -> Text-to-speech**) -- tell me the exact name
that shows up there if you want it hardcoded to a specific one.

## Fix: first segment used to run at 1 km/h

The pad spins its belt up at its own default (1.0 km/h) on Start and
ignores a set-speed arriving in that same instant. Fixed by sending
the first set-speed ~1.8s after Start (the info box shows "Starting
up..." during that gap), plus a retry that checks the pad's reported
speed and resends up to 4 times if it didn't take -- this also covers
the manual speed buttons. Can't test the exact timing against your
pad; if you still see a wrong first speed, tell me and I'll lengthen
the delay.

## Pause and live programme info

A three-button row (Start / Pause / Stop). Pause sets speed to 0 and
remembers your prior speed for Resume, speaks "Walking pad paused." /
"Resuming workout.", and freezes a running programme's countdown while
paused. While a programme runs, a dark info box above the video player
readout shows the programme name, current step ("Step 3/7: Peak
Training (6.4 km/h)"), and a countdown, with a **Cancel programme**
button inside it.

## Galaxy Watch 4 control -- what's possible, honestly

There's no way for a watch app to send commands straight to a web
page -- doing it "properly" needs a native Wear OS app plus a native
phone app to relay through, a separate project entirely. What's built
instead uses the route that genuinely exists: your watch can already
control **media playing on your phone**, and the Media Session API
lets this page register as that media source.

Tap **Watch** in the top bar to enable it. The watch's Media tile then
becomes a pad remote:

- **Play (>)** -> Start, or Resume if paused
- **Pause (||)** -> Pause (freezes a running programme's countdown)
- **Previous (|<)** -> Stop, cancelling any running programme

The play/pause icon stays in sync with the pad's actual state either
way it changes (phone buttons or the pad itself).

**One real limit**: a web page can only hook the *standard* media
actions, so the watch shows its usual play/pause/previous icons, not
custom "Start/Pause/Stop" labels -- that needs a native Wear OS app.
Next-track is deliberately left unassigned so a stray swipe can't do
something unexpected mid-walk. Android can also suspend media sessions
from backgrounded browser tabs, so keeping the PWA in the foreground
(screen wake-locked anyway) is the reliable setup. If this proves too
flaky in practice, a cheap Bluetooth remote shutter button clipped to
the pad is a more reliable fallback -- say the word and I'll wire up
key-event handling for one.

Voice control is unchanged and still has its own **Voice** button --
the watch doesn't touch it.

## Screen stays awake mid-walk

The desktop app's wake-lock behaviour is ported over, so the S23's
screen won't lock itself mid-programme. It re-requests the lock
automatically if the tab regains focus.

## Everything else carried over from the desktop app

- Frame format, checksums, and all six commands (`query_info`,
  `query_status`, `poll`, `start`, `stop`, `set_speed`) -- byte-for-byte
  identical to `fitshow_protocol.py`
- Speed/time/distance/calories parsing from the poll replies
- No step count (the pad doesn't report one) and no incline control
  (this unit's incline is fixed)
- YouTube video panel, remembers the last video loaded
