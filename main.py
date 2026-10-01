"""
Simple WebRTC Meeting App - Backend
------------------------------------
FastAPI server that does two jobs:

1. Signaling server (WebSocket) - helps browsers find each other and
   exchange the technical info (SDP offers/answers + ICE candidates)
   needed to open a direct peer-to-peer audio/video connection.
   The actual audio/video never passes through this server.

2. Plain REST API - create instant meeting rooms and schedule
   meetings for later (stored in memory for simplicity).

Run with:  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import io
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Load settings from the .env file next to main.py (no extra package needed).
# Real environment variables always win over .env; empty values are ignored.
# ---------------------------------------------------------------------------
def _load_dotenv():
    p = Path(__file__).parent / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v:
            os.environ.setdefault(k, v)


_load_dotenv()

# ---------------------------------------------------------------------------
# Recording + transcription settings (all free / offline, override with env vars)
# ---------------------------------------------------------------------------
DATA_DIR = Path(os.getenv("DATA_DIR") or (Path(__file__).parent / "data"))
REC_DIR = DATA_DIR / "recordings"
TR_DIR = DATA_DIR / "transcripts"
MODEL_DIR = DATA_DIR / "models"
for _d in (REC_DIR, TR_DIR, MODEL_DIR):
    _d.mkdir(parents=True, exist_ok=True)

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")      # tiny | base | small | medium | or a local folder path
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")   # int8 = fast on CPU
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")      # "cuda" if you have an NVIDIA GPU
WHISPER_THREADS = int(os.getenv("WHISPER_CPU_THREADS", "0"))  # 0 = auto
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None  # e.g. "en", "hi"; empty = auto-detect


def find_ffmpeg() -> Optional[str]:
    """ffmpeg is optional: if it is found it is used to tidy recordings; otherwise built-in PyAV does the job."""
    p = os.getenv("FFMPEG_PATH")
    if p and Path(p).is_file():
        return p
    return shutil.which("ffmpeg")


MAX_PENDING_CLIPS = int(os.getenv("MAX_PENDING_CLIPS", "4"))  # drop clips if the CPU can't keep up

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def safe_id(value: str) -> str:
    if not SAFE_ID.match(value or ""):
        raise HTTPException(status_code=400, detail="bad id")
    return value


# ---------------------------------------------------------------------------
# Whisper (faster-whisper): loaded once in the background at startup
# ---------------------------------------------------------------------------
_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()   # one transcription at a time
_pending = 0
model_state = {"state": "loading", "error": "", "last_try": 0.0}   # loading | ready | error


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            model_state.update(state="loading", last_try=time.time())
            try:
                from faster_whisper import WhisperModel
                print(f"[meet] loading Whisper '{WHISPER_MODEL}' (first run downloads it once)...", flush=True)
                _model = WhisperModel(
                    WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE,
                    cpu_threads=WHISPER_THREADS, download_root=str(MODEL_DIR),
                )
                print("[meet] Whisper ready", flush=True)
            except Exception as e:
                model_state.update(state="error", error=str(e)[:300])
                print(f"[meet] Whisper failed to load: {e}", flush=True)
                raise
        model_state.update(state="ready", error="")
        return _model


def start_model_load():
    threading.Thread(target=lambda: _safe(get_model), daemon=True).start()


def _safe(fn):
    try:
        fn()
    except Exception:
        pass


def transcribe_pcm(pcm: np.ndarray, language: Optional[str]) -> str:
    """16 kHz mono float32 audio -> text."""
    model = get_model()
    with _infer_lock:
        segments, _ = model.transcribe(
            pcm, language=language, beam_size=1, vad_filter=True,
            condition_on_previous_text=False, without_timestamps=True,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()


def _decode_with_av(data: bytes) -> np.ndarray:
    import av
    chunks = []
    with av.open(io.BytesIO(data), mode="r") as container:
        stream = next((st for st in container.streams if st.type == "audio"), None)
        if stream is None:
            raise RuntimeError("no audio track in clip")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)

        def take(out):
            for f in (out if isinstance(out, list) else [out]):
                if f is not None:
                    chunks.append(f.to_ndarray().reshape(-1))

        for frame in container.decode(stream):
            take(resampler.resample(frame))
        take(resampler.resample(None))   # flush
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32)


def decode_audio(data: bytes) -> np.ndarray:
    """Browser audio clip (webm/ogg/mp4) -> 16 kHz mono float32.
    Uses PyAV (installed with faster-whisper), so ffmpeg is NOT needed. If PyAV can't read a clip
    and ffmpeg exists, ffmpeg is tried as a fallback."""
    try:
        return _decode_with_av(data)
    except Exception as e_av:
        ff = find_ffmpeg()
        if not ff:
            raise RuntimeError(f"audio decode failed: {e_av}")
        proc = subprocess.run(
            [ff, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
            input=data, capture_output=True, timeout=60,
        )
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg decode failed: " + proc.stderr.decode(errors="ignore")[:200])
        raw = proc.stdout
        return np.frombuffer(raw[: len(raw) - len(raw) % 4], dtype=np.float32)


def transcribe_clip(data: bytes, language: Optional[str]) -> str:
    pcm = decode_audio(data)
    if len(pcm) < 16000 * 0.4 or float(np.sqrt(np.mean(pcm * pcm))) < 0.004:
        return ""   # silence / muted mic - skip (also avoids Whisper "hallucinations")
    return transcribe_pcm(pcm, language)


@asynccontextmanager
async def lifespan(_app):
    start_model_load()
    print(f"[meet] ffmpeg: {find_ffmpeg() or 'not found (optional - built-in PyAV is used)'}", flush=True)
    yield


app = FastAPI(title="Simple WebRTC Meet", lifespan=lifespan)

# ---------------------------------------------------------------------------
# In-memory state (fine for a small/simple deployment; swap for a DB later)
# ---------------------------------------------------------------------------

# room_id -> { client_id: WebSocket }
rooms: Dict[str, Dict[str, WebSocket]] = {}

# list of scheduled meetings (dicts)
scheduled_meetings: List[dict] = []

# room_id -> {"recording", "recording_id", "rec_owner", "transcription"}
flags: Dict[str, dict] = {}
# recording_id -> {"room", "path", "ext", "status", "bytes"}
recordings: Dict[str, dict] = {}


def room_flags(room_id: str) -> dict:
    return flags.setdefault(room_id, {"recording": False, "recording_id": None, "rec_owner": None, "transcription": False})


def status_msg(room_id: str) -> dict:
    f = room_flags(room_id)
    return {"type": "status", "recording": f["recording"], "recordingId": f["recording_id"], "transcription": f["transcription"]}


async def broadcast(room_id: str, message: dict, exclude: Optional[str] = None):
    for cid, ws in list(rooms.get(room_id, {}).items()):
        if cid != exclude:
            try:
                await ws.send_json(message)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

class ScheduleRequest(BaseModel):
    title: str
    time: str          # ISO datetime string coming from the <input type="datetime-local">
    host_name: str = ""


@app.get("/api/new-room")
def new_room():
    """Generate a fresh, random room id for an instant meeting."""
    return {"room": uuid.uuid4().hex[:8]}


@app.post("/api/schedule")
def schedule_meeting(req: ScheduleRequest):
    """Create a scheduled meeting and return its shareable room id."""
    room_id = uuid.uuid4().hex[:8]
    meeting = {
        "id": room_id,
        "title": req.title,
        "time": req.time,
        "host_name": req.host_name,
        "created_at": datetime.datetime.utcnow().isoformat(),
    }
    scheduled_meetings.append(meeting)
    return meeting


@app.get("/api/schedule")
def list_meetings():
    """List all scheduled meetings, soonest first."""
    return sorted(scheduled_meetings, key=lambda m: m["time"])


@app.delete("/api/schedule/{meeting_id}")
def cancel_meeting(meeting_id: str):
    global scheduled_meetings
    scheduled_meetings = [m for m in scheduled_meetings if m["id"] != meeting_id]
    return {"ok": True}


# ---------------------------------------------------------------------------
# Recording API
# ---------------------------------------------------------------------------
# Flow: the browser that clicks "Record" mixes all audio + tiles all video into one canvas,
# records it with MediaRecorder and uploads 5-second chunks here. The server appends them to a
# file and, when finished, runs ffmpeg (-c copy) so the file has a proper duration / is seekable.

def _rec_file(rec_id: str) -> Optional[Path]:
    rec_id = safe_id(rec_id)
    if rec_id in recordings:
        return Path(recordings[rec_id]["path"])
    found = list(REC_DIR.glob(f"*__{rec_id}.*"))
    return found[0] if found else None


@app.post("/api/recordings")
async def create_recording(room: str, ext: str = "webm"):
    safe_id(room)
    if ext not in ("webm", "mp4"):
        raise HTTPException(status_code=400, detail="bad ext")
    if room_flags(room)["recording"]:
        raise HTTPException(status_code=409, detail="This meeting is already being recorded")
    rec_id = uuid.uuid4().hex[:12]
    path = REC_DIR / f"{room}__{rec_id}.{ext}"
    path.write_bytes(b"")
    recordings[rec_id] = {"room": room, "path": str(path), "ext": ext, "status": "recording", "bytes": 0}
    return {"id": rec_id}


def _append(path: str, data: bytes):
    with open(path, "ab") as f:
        f.write(data)


@app.put("/api/recordings/{rec_id}/chunks")
async def upload_chunk(rec_id: str, request: Request):
    rec = recordings.get(safe_id(rec_id))
    if not rec or rec["status"] != "recording":
        raise HTTPException(status_code=404, detail="recording not open")
    data = await request.body()
    await asyncio.to_thread(_append, rec["path"], data)
    rec["bytes"] += len(data)
    return {"bytes": rec["bytes"]}


def _remux_av(src: Path, tmp: Path, ext: str):
    """Stream-copy remux with PyAV so the file gets a proper duration and can be seeked (no ffmpeg needed)."""
    import av
    with av.open(str(src)) as inp, av.open(str(tmp), "w", format="webm" if ext == "webm" else "mp4") as out:
        mapping = {s.index: out.add_stream_from_template(s) for s in inp.streams if s.type in ("video", "audio")}
        for pkt in inp.demux(*[inp.streams[i] for i in mapping]):
            if pkt.dts is None:
                continue
            pkt.stream = mapping[pkt.stream.index]
            out.mux(pkt)


def _remux(path: str, ext: str):
    src = Path(path)
    tmp = src.with_name(src.stem + ".fixed." + ext)
    try:
        ff = find_ffmpeg()
        if ff:
            cmd = [ff, "-y", "-loglevel", "error", "-i", str(src), "-c", "copy"] + (["-movflags", "+faststart"] if ext == "mp4" else [])
            r = subprocess.run(cmd + [str(tmp)], capture_output=True, timeout=600)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.decode(errors="ignore")[:200])
        else:
            _remux_av(src, tmp, ext)
        if tmp.exists() and tmp.stat().st_size > 0:
            os.replace(tmp, src)
    except Exception as e:
        tmp.unlink(missing_ok=True)   # keep the raw (still playable) file if tidy-up fails
        print("[meet] remux skipped, kept raw file:", e, flush=True)


async def finalize_recording(rec_id: str):
    rec = recordings.get(rec_id)
    if not rec or rec["status"] != "recording":
        return
    rec["status"] = "processing"
    if rec["bytes"] > 0:
        await asyncio.to_thread(_remux, rec["path"], rec["ext"])
    rec["status"] = "ready"


@app.post("/api/recordings/{rec_id}/complete")
async def complete_recording(rec_id: str):
    if safe_id(rec_id) not in recordings:
        raise HTTPException(status_code=404, detail="unknown recording")
    await finalize_recording(rec_id)
    return {"ok": True, "status": recordings[rec_id]["status"]}


@app.get("/api/rooms/{room}/recordings")
def list_recordings(room: str):
    safe_id(room)
    items = []
    for p in sorted(REC_DIR.glob(f"{room}__*"), key=lambda x: x.stat().st_mtime, reverse=True):
        if ".fixed." in p.name:
            continue
        rec_id = p.stem.split("__", 1)[1]
        status = recordings.get(rec_id, {}).get("status", "ready")
        items.append({
            "id": rec_id, "status": status, "size": p.stat().st_size,
            "created": datetime.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
            "url": f"/api/recordings/{rec_id}/download",
        })
    return items


@app.get("/api/recordings/{rec_id}/download")
def download_recording(rec_id: str):
    p = _rec_file(rec_id)
    if not p or not p.exists() or recordings.get(rec_id, {}).get("status") in ("recording", "processing"):
        raise HTTPException(status_code=404, detail="not ready")
    return FileResponse(p, filename=f"meeting-{p.name.replace('__', '-')}")


# ---------------------------------------------------------------------------
# Transcription API
# ---------------------------------------------------------------------------
# Every participant records their OWN microphone in short clips while transcription is on and
# uploads them here. That gives correct speaker names for free. The server decodes each clip
# with ffmpeg, runs Whisper locally, saves the text and pushes it to everybody as a live caption.

_tr_lock = threading.Lock()


@app.get("/api/whisper-status")
def whisper_status():
    if model_state["state"] == "error" and time.time() - model_state["last_try"] > 30:
        start_model_load()          # retry (e.g. internet came back)
    return {"state": model_state["state"], "error": model_state["error"], "model": WHISPER_MODEL}


@app.post("/api/transcribe")
async def transcribe_endpoint(request: Request, room: str, name: str = "Guest", dur_ms: int = 8000):
    global _pending
    safe_id(room)
    if not room_flags(room)["transcription"]:
        return {"skipped": "transcription off"}
    if model_state["state"] != "ready":
        if model_state["state"] == "error" and time.time() - model_state["last_try"] > 30:
            start_model_load()
        return {"skipped": "model " + model_state["state"], "error": model_state["error"]}
    if _pending >= MAX_PENDING_CLIPS:
        return {"skipped": "busy"}
    data = await request.body()
    if len(data) < 1500:
        return {"skipped": "empty"}
    received = time.time()
    _pending += 1
    try:
        text = await asyncio.to_thread(transcribe_clip, data, WHISPER_LANGUAGE)
    except Exception as e:
        print("[meet] transcription error:", e, flush=True)
        return JSONResponse({"error": str(e)[:200]}, status_code=502)
    finally:
        _pending -= 1
    if not text:
        return {"skipped": "no speech"}
    seg = {"name": name[:40] or "Guest", "text": text, "time": received - dur_ms / 1000.0}
    with _tr_lock:
        with open(TR_DIR / f"{room}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(seg, ensure_ascii=False) + "\n")
    await broadcast(room, {"type": "transcript", "segment": seg})
    return seg


@app.get("/api/rooms/{room}/transcript")
def get_transcript(room: str, format: str = "json", download: int = 0):
    safe_id(room)
    path = TR_DIR / f"{room}.jsonl"
    segs = []
    if path.exists():
        segs = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    segs.sort(key=lambda x: x["time"])
    if format == "text":
        text = "\n".join(
            f"[{datetime.datetime.fromtimestamp(x['time']).strftime('%H:%M:%S')}] {x['name']}: {x['text']}" for x in segs
        )
        headers = {"Content-Disposition": f'attachment; filename="transcript-{room}.txt"'} if download else None
        return PlainTextResponse(text, headers=headers)
    return JSONResponse(segs)


# ---------------------------------------------------------------------------
# WebSocket signaling
# ---------------------------------------------------------------------------
#
# Flow for N people in a room:
#  1. New client connects to /ws/{room_id}/{client_id}
#  2. Server tells the new client who is already in the room ("existing-peers")
#  3. Server tells everyone already in the room that a new peer joined ("new-peer")
#  4. The browser logic (app.js) decides, per pair, who sends the SDP "offer"
#     and who replies with an "answer" - the server just relays these messages
#     (and "ice-candidate" messages) to the right target client.
#  5. On disconnect, everyone else is told ("peer-left") so they can clean up.


@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str):
    await websocket.accept()

    room = rooms.setdefault(room_id, {})

    # 1) tell the newcomer who is already here
    await websocket.send_json({"type": "existing-peers", "peers": list(room.keys())})

    # 1b) tell the newcomer whether recording / captions are already on
    await websocket.send_json(status_msg(room_id))

    # 2) add newcomer to the room
    room[client_id] = websocket

    # 3) tell everyone else about the newcomer
    for peer_id, ws in room.items():
        if peer_id != client_id:
            await ws.send_json({"type": "new-peer", "peer": client_id})

    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")

            # --- recording / transcription switches (visible to everyone in the room) ---
            if mtype == "set-transcription":
                room_flags(room_id)["transcription"] = bool(message.get("active"))
                await broadcast(room_id, status_msg(room_id))
                continue
            if mtype == "set-recording":
                f = room_flags(room_id)
                if message.get("active"):
                    rid = str(message.get("recordingId", ""))
                    if not f["recording"] and SAFE_ID.match(rid) and rid in recordings:
                        f.update(recording=True, recording_id=rid, rec_owner=client_id)
                else:
                    f.update(recording=False, recording_id=None)   # the recording browser sees this and finishes uploading
                await broadcast(room_id, status_msg(room_id))
                continue
            if mtype == "get-status":
                await websocket.send_json(status_msg(room_id))
                continue
            if mtype == "hello":
                continue

            target = message.get("target")
            message["sender"] = client_id
            target_ws = room.get(target)
            if target_ws is not None:
                await target_ws.send_json(message)

    except WebSocketDisconnect:
        room.pop(client_id, None)
        f = room_flags(room_id)
        if f["rec_owner"] == client_id:      # the browser that was recording left: close the file
            rid = f["recording_id"]
            f.update(recording=False, recording_id=None, rec_owner=None)
            if rid:
                asyncio.create_task(finalize_recording(rid))
        for peer_id, ws in list(room.items()):
            try:
                await ws.send_json({"type": "peer-left", "peer": client_id})
            except Exception:
                pass
        if not room:
            rooms.pop(room_id, None)
            flags.pop(room_id, None)
        else:
            await broadcast(room_id, status_msg(room_id))


@app.middleware("http")
async def no_cache_for_app_files(request: Request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------------------------------------------------------------------------
# Static frontend (must be mounted last so /api and /ws routes above win)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8000")), ws_ping_interval=20, ws_ping_timeout=90)
