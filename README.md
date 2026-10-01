# Meet — a simple WebRTC video calling app

A small video‑calling tool you can run yourself. It does the three things you asked for:

1. **Multiple people can join** a call using one link.
2. **People can leave/disconnect** at any time, and everyone else's screen updates.
3. **Video calls / meetings** work directly between browsers (peer‑to‑peer) plus a **schedule a meeting** feature that gives you a shareable link for later.

Backend: **FastAPI** (Python). Frontend: plain **HTML/CSS/JavaScript** — no framework, kept intentionally simple.

---

## 1. How it works (in plain terms)

WebRTC lets two browsers send video/audio **directly to each other** — the video itself never
touches your server. But the two browsers still need a way to "meet" each other first and swap some
connection details. That's what your FastAPI server does: it's a **signaling server**, basically a
matchmaker.

```
 You (Laptop)                     FastAPI Server                    Manager (Anywhere)
 ┌───────────┐   1. joins room     ┌───────────┐   1. joins room     ┌───────────┐
 │  Browser  │ ─────────────────▶ │  /ws/room │ ◀───────────────── │  Browser  │
 │           │  2. exchange offer/ │  (relay)  │  2. exchange offer/ │           │
 │           │     answer/ICE      └───────────┘     answer/ICE      │           │
 └───────────┘ ─────────────────────────────────────────────────── ▶└───────────┘
        \_______________________ 3. direct video/audio stream ______________________/
```

For 3+ people, every browser connects directly to every other browser (a small "mesh"). This is
simple and works great for a handful of people (2–6). It's not meant for 50‑person webinars.

---

## 2. What's in the folder

```
webrtc-meet/
├── main.py            # FastAPI backend: signaling (WebSocket) + schedule API
├── requirements.txt   # Python dependencies
└── static/
    ├── index.html     # Home page: start / join / schedule
    ├── room.html       # The actual call screen
    ├── style.css      # All styling (simple, dark theme)
    ├── home.js        # Logic for the home page
    └── call.js        # WebRTC logic for the call screen
```

---

## 3. Running it on your laptop

**Requirements:** Python 3.9+ installed.

```bash
cd webrtc-meet
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Now open **http://localhost:8000** in your browser. That's it — the app is running.

---

## 4. Using it

### Start an instant call
1. Open the home page, type your name, click **Start instant meeting**.
2. Your browser will ask for camera/microphone permission — click **Allow**.
3. You land on the call screen. Click **Copy invite link** and send it to your manager/colleagues
   (Slack, WhatsApp, email — however you'd normally share a link).
4. Anyone who opens that link and clicks **Join call** appears on your screen, and you appear on
   theirs. This works for multiple people at once, not just two.

### Leave a call
Click the red **Leave** button any time. Everyone else in the call is notified immediately and your
video tile disappears from their screens.

### Mute / camera controls
The two round buttons above **Leave** toggle your microphone and camera on/off.

### Schedule a meeting for later
1. On the home page, fill in a title and pick a date/time, click **Schedule**.
2. It appears in the list below with **Copy link**, **Join**, and **Delete** buttons.
3. Copy the link now and send it to whoever needs it — they can open it and click **Join call**
   whenever the meeting time comes (this app doesn't send emails/reminders automatically; you
   share the link yourself, the same way you'd share a Zoom/Meet link).

---

## 5. Important: making it work for other people, not just you

If you only run `uvicorn` on your laptop and share a `localhost:8000` link, **no one else can open
it** — `localhost` only means "this machine." You have two options:

### Option A — Quick and free: use a tunnel (good for trying it out today)
[ngrok](https://ngrok.com) makes your local server temporarily reachable from the internet.

```bash
# one-time setup
# download ngrok from https://ngrok.com/download, then:
ngrok http 8000
```

It will print a public link like `https://abcd1234.ngrok-free.app`. Open the app at **that** URL
instead of `localhost`, and share links generated from that URL. Keep your laptop and the `uvicorn`
+ `ngrok` terminals running for the whole call — closing them ends the meeting for everyone.

### Option B — Proper hosting (good for regular/daily use with your manager)
Deploy the app to a small cloud server so it has a permanent address, for example:
- **Render.com** or **Railway.app** (free/cheap tiers, deploy straight from a GitHub repo)
- A basic **VPS** (DigitalOcean, AWS Lightsail, etc.) running `uvicorn` behind Nginx with HTTPS

Once deployed, `localhost:8000` becomes something like `https://meet.yourdomain.com`, and links work
for anyone, anytime, without your laptop needing to be on.

**Note on HTTPS:** browsers require a secure connection (`https://`) for camera/microphone access on
any address other than `localhost`. ngrok and the hosting options above give you HTTPS automatically.

---

## 6. Known limits (so there are no surprises)

- **Group size:** works well for small groups (roughly up to 5–6 people). Beyond that, everyone's
  upload bandwidth becomes the bottleneck since each person sends video to every other person
  directly.
- **No recording, no chat, no screen share** — kept out to keep this quick and simple, as requested.
  They can be added later if you need them.
- **No accounts/login** — anyone with a link can join, same as a typical Zoom/Meet link without a
  waiting room.
- **Scheduled meetings don't send reminders** — you still need to share the link yourself.
- **Restarting the server clears scheduled meetings** — they're stored in memory, not a database.
  Fine for personal/small-team use; say the word if you want them saved to a file or database instead.

---

## 7. Quick troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Camera/mic prompt never appears | Site opened over plain `http://` on a non-localhost address | Use `https://` (via ngrok or real hosting) |
| Other person can't open the link | You shared a `localhost` link | Share the ngrok/hosted URL instead |
| Video connects but freezes/drops | Weak Wi‑Fi upload speed | Move closer to the router, or lower participant count |
| "Could not access camera" alert | Another app (Zoom/Teams) is using the camera | Close other video apps and retry |

---

## Recording + free offline transcription (added)

No paid or external API. Everything runs on the machine that runs `main.py`.

### Setup
```bash
pip install -r requirements.txt        # adds faster-whisper (free, offline Whisper)
python main.py                          # or: uvicorn main:app --host 0.0.0.0 --port 8000 --ws-ping-timeout 90
```
**ffmpeg is NOT required.** Audio decoding and tidying the recording file are done by PyAV, which installs with faster-whisper. If you do have ffmpeg, set `FFMPEG_PATH` in `.env` to the full path of `ffmpeg.exe` and it will be used for the recording tidy-up.

Settings live in the **`.env`** file next to `main.py` (model size, language, ffmpeg path, data folder, port). Edit it, then restart the server.

The first start downloads the Whisper **small** model once (~460 MB) into `data/models/`; watch the console for `[meet] Whisper ready`. Until then the CC button shows "Speech model is loading". After that it works with no internet (copy `data/models/` to another PC to run fully offline).

### Using it
In the call screen:
- **⏺ Record** — anybody can start/stop. Everyone sees a blinking **REC** badge. The browser that clicked Record mixes all voices + all video tiles into one video and uploads it to `data/recordings/`. Keep that tab visible and keep that person in the call until it says "Recording saved".
- **CC** — turns live captions on for everybody (badge **CC on**). Each person's own mic is transcribed, so captions show the right speaker name. Full text is saved to `data/transcripts/<room>.jsonl`.
- **📁** — side panel: download recordings and the transcript (`.txt`). Also available directly:
  `/api/rooms/<room>/recordings`, `/api/rooms/<room>/transcript?format=text`.

### Settings (environment variables, all optional)
| Variable | Default | Meaning |
|---|---|---|
| `FFMPEG_PATH` | none (optional) | full path to ffmpeg(.exe), only used to tidy recordings |
| `WHISPER_MODEL` | `small` | `tiny` (fastest) · `base` · `small` · `medium` (best, slow) |
| `WHISPER_LANGUAGE` | auto | e.g. `en`, `hi` — setting it improves accuracy/speed |
| `WHISPER_COMPUTE` / `WHISPER_DEVICE` | `int8` / `cpu` | use `cuda` + `float16` with an NVIDIA GPU |
| `WHISPER_CPU_THREADS` | auto | CPU threads for Whisper |
| `MAX_PENDING_CLIPS` | `4` | if the CPU falls behind, extra audio clips are dropped instead of piling up |
| `DATA_DIR` | `./data` | where recordings / transcripts / models are stored |

### Honest limits
- Captions arrive ~10–20 s after speaking (8-second clips + CPU time). `small` on a weak CPU may lag with several people talking; use `base` or `tiny` or set `WHISPER_LANGUAGE`.
- Recording is made in one browser: if that person closes the tab mid-call, the file is closed with what was uploaded so far.
- There is no login: anyone who knows a meeting code can open its recordings/transcript links. Don't expose this publicly without adding authentication.
- Camera/mic and recording need **HTTPS** (or `localhost`) when other people join from other devices.

### If a button does nothing
1. **Hard refresh both browsers** (Ctrl+F5). Old versions of `call.js` / `style.css` can be cached. The server now sends `no-cache` and the page loads `?v=3` files, but a previous cached copy of `room.html` can linger once.
2. Look at the small message that pops up at the bottom — it now says if the speech model is still loading/failed, the mic is unavailable, or the server is not connected.
3. Other devices need **https://** (or `http://localhost`) for camera/mic. Without them there is no microphone to transcribe.
4. The server console prints `[meet] transcription error: ...` for any decode/Whisper problem.
