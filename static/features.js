// Recording + live transcription (loaded after call.js; uses its globals: ws, localStream, roomId).
(function () {
  const $ = (id) => document.getElementById(id);
  const toast = (m) => { const t = $('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
  const myName = () => localStorage.getItem('meet_name') || 'Guest';

  let status = { recording: false, recordingId: null, transcription: false };
  let recorder = null;       // set only in the browser that is recording
  let transcriber = null;    // every browser transcribes its own mic while CC is on
  let captionTimer = null;

  // ---------- signaling hook ----------
  // Attach to the call's WebSocket. Works through call.js's hook AND by polling for `ws`,
  // so it still works if the browser is holding an older cached call.js.
  let attached = null;
  function attach(socket) {
    if (!socket || attached === socket) return;
    attached = socket;
    socket.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'status') applyStatus(msg);
      else if (msg.type === 'transcript') addTranscript(msg.segment);
    });
    const ask = () => socket.readyState === 1 ? socket.send(JSON.stringify({ type: 'get-status' })) : socket.addEventListener('open', ask, { once: true });
    ask();
  }
  window.onSignalingReady = attach;
  setInterval(() => { try { if (typeof ws !== 'undefined' && ws && ws !== attached) attach(ws); } catch (_) {} }, 300);
  window.beforeLeave = async () => { stopTranscriber(); if (recorder) await stopRecording(); };
  const send = (obj) => {
    if (typeof ws !== 'undefined' && ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    toast('Not connected to the server yet'); return false;
  };
  let lastNote = 0;
  const noteOnce = (m) => { if (Date.now() - lastNote > 20000) { lastNote = Date.now(); toast(m); } };

  // ---------- status (same for everyone: REC / CC indicators) ----------
  function applyStatus(s) {
    const was = status; status = s;
    $('recPill').style.display = s.recording ? '' : 'none';
    $('ccPill').style.display = s.transcription ? '' : 'none';
    $('recBtn').classList.toggle('rec-on', s.recording);
    $('ccBtn').classList.toggle('on', s.transcription);
    if (s.recording !== was.recording && !recorder) toast(s.recording ? 'Recording started' : 'Recording stopped');
    if (s.transcription !== was.transcription) toast(s.transcription ? 'Live captions & transcription on' : 'Transcription off');
    if (s.transcription && !transcriber) startTranscriber();
    if (!s.transcription) stopTranscriber();
    if (!s.recording && recorder && Date.now() - recorder.startedAt > 3000) stopRecording();   // stopped by anyone -> the recording browser finishes uploading
  }

  // ---------- recording ----------
  let starting = false;
  $('recBtn').addEventListener('click', async () => {
    if (starting) return;
    if (recorder || status.recording) { send({ type: 'set-recording', active: false }); return; }   // stop (mine or someone else's)
    if (typeof MediaRecorder === 'undefined') return toast('Recording is not supported in this browser');
    starting = true;
    try {
      const mime = pickMime();
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const r = await fetch(`/api/recordings?room=${encodeURIComponent(roomId)}&ext=${ext}`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'server refused');
      const { id } = await r.json();
      recorder = new CompositeRecorder(id, mime);
      recorder.start();
      if (!send({ type: 'set-recording', active: true, recordingId: id })) { await stopRecording(); }
    } catch (e) { recorder = null; toast('Could not start recording: ' + e.message); }
    finally { starting = false; }
  });

  function pickMime() {
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function stopRecording() {
    const r = recorder; recorder = null;
    if (!r) return;
    await r.stop();
    toast('Recording saved');
    loadRecordings();
  }

  // Mixes every tile's audio and draws every tile's video onto one canvas, then records that.
  // Keep this tab visible while recording (browsers slow down hidden tabs).
  class CompositeRecorder {
    constructor(id, mime) { this.id = id; this.mime = mime; this.startedAt = Date.now(); this.queue = Promise.resolve(); this.sources = new Map(); }
    start() {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const c = canvas.getContext('2d');
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.dest = this.ctx.createMediaStreamDestination();
      const draw = () => {
        const vids = [...document.querySelectorAll('#videoGrid video')].filter((v) => v.srcObject);
        const seen = new Set();
        vids.forEach((v) => {
          const s = v.srcObject; seen.add(s.id);
          if (!this.sources.has(s.id) && s.getAudioTracks().length) {
            const src = this.ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
            src.connect(this.dest); this.sources.set(s.id, src);
          }
        });
        [...this.sources.keys()].forEach((k) => { if (!seen.has(k)) { this.sources.get(k).disconnect(); this.sources.delete(k); } });
        c.fillStyle = '#10141a'; c.fillRect(0, 0, canvas.width, canvas.height);
        const n = Math.max(vids.length, 1), cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
        const w = canvas.width / cols, h = canvas.height / rows;
        vids.forEach((v, i) => {
          if (!v.videoWidth) return;
          const k = Math.min((w - 8) / v.videoWidth, (h - 8) / v.videoHeight);
          const dw = v.videoWidth * k, dh = v.videoHeight * k;
          c.drawImage(v, (i % cols) * w + (w - dw) / 2, Math.floor(i / cols) * h + (h - dh) / 2, dw, dh);
        });
      };
      draw();
      // a Worker timer keeps ticking even when the tab is in the background
      this.worker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),66)'], { type: 'text/javascript' })));
      this.worker.onmessage = draw;
      const tracks = [...this.dest.stream.getAudioTracks(), ...canvas.captureStream(15).getVideoTracks()];
      this.rec = new MediaRecorder(new MediaStream(tracks), { mimeType: this.mime || undefined, videoBitsPerSecond: 2000000 });
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.queue = this.queue.then(() => this.upload(e.data)); };
      this.rec.start(5000);
    }
    async upload(blob) {
      for (let i = 0; i < 4; i++) {
        try { const r = await fetch(`/api/recordings/${this.id}/chunks`, { method: 'PUT', body: blob }); if (r.ok) return; } catch (_) {}
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
      console.error('chunk upload failed');
    }
    async stop() {
      if (this.worker) this.worker.terminate();
      if (this.rec && this.rec.state !== 'inactive') {
        await new Promise((res) => { this.rec.addEventListener('stop', res, { once: true }); this.rec.stop(); });
      }
      await new Promise((r) => setTimeout(r, 100));
      await this.queue;
      try { await fetch(`/api/recordings/${this.id}/complete`, { method: 'POST' }); } catch (_) {}
      if (this.ctx) this.ctx.close();
    }
  }

  // ---------- transcription (each person's own mic -> server Whisper -> captions for all) ----------
  $('ccBtn').addEventListener('click', async () => {
    if (!status.transcription) {
      if (typeof localStream === 'undefined' || !localStream) return toast('No microphone access. Open the site via https:// or http://localhost');
      try {
        const w = await (await fetch('/api/whisper-status')).json();
        if (w.state === 'loading') toast('Speech model is loading (first run downloads it, ~460 MB). Captions start when it is ready.');
        if (w.state === 'error') toast('Speech model failed to load: ' + w.error);
      } catch (_) {}
    }
    send({ type: 'set-transcription', active: !status.transcription });
  });

  function startTranscriber() {
    if (transcriber || typeof localStream === 'undefined' || !localStream || typeof MediaRecorder === 'undefined') return;
    transcriber = { running: true };
    const audio = new MediaStream(localStream.getAudioTracks());
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const CLIP = 8000;
    (async () => {
      while (transcriber && transcriber.running) {
        const micAtStart = audio.getAudioTracks().some((t) => t.enabled);
        const blob = await new Promise((resolve) => {
          const rec = new MediaRecorder(audio, mime ? { mimeType: mime } : undefined);
          const parts = [];
          rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
          rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType }));
          rec.start();
          setTimeout(() => rec.state !== 'inactive' && rec.stop(), CLIP);
        });
        const micAtEnd = audio.getAudioTracks().some((t) => t.enabled);
        if (!micAtStart && !micAtEnd) continue;                       // muted the whole time: nothing to send
        fetch(`/api/transcribe?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(myName())}&dur_ms=${CLIP}`, {
          method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
        }).then((r) => r.json()).then((j) => {
          if (j.error) noteOnce('Transcription error: ' + j.error);
          else if (j.skipped && String(j.skipped).startsWith('model')) noteOnce('Speech model is ' + String(j.skipped).replace('model ', '') + (j.error ? ': ' + j.error : '...'));
        }).catch(() => {});
      }
    })();
  }
  function stopTranscriber() { if (transcriber) transcriber.running = false; transcriber = null; }

  function addTranscript(seg) {
    const cap = $('caption');
    cap.innerHTML = ''; const b = document.createElement('b'); b.textContent = seg.name + ': ';
    cap.append(b, document.createTextNode(seg.text)); cap.style.display = '';
    clearTimeout(captionTimer); captionTimer = setTimeout(() => (cap.style.display = 'none'), 7000);
    const log = $('trLog'); if (log.querySelector('.empty-note')) log.innerHTML = '';
    const line = document.createElement('div'); line.className = 'tr-line';
    const nb = document.createElement('b'); nb.textContent = seg.name + ': ';
    line.append(nb, document.createTextNode(seg.text)); log.appendChild(line); log.scrollTop = log.scrollHeight;
  }

  // ---------- side panel: recordings + transcript download ----------
  $('panelBtn').addEventListener('click', () => { const p = $('sidePanel'); p.style.display = p.style.display === 'none' ? '' : 'none'; if (p.style.display === '') loadRecordings(); });
  $('panelClose').addEventListener('click', () => ($('sidePanel').style.display = 'none'));
  $('trDownload').href = `/api/rooms/${encodeURIComponent(roomId)}/transcript?format=text&download=1`;

  async function loadRecordings() {
    const box = $('recList');
    try {
      const items = await (await fetch(`/api/rooms/${encodeURIComponent(roomId)}/recordings`)).json();
      box.innerHTML = '';
      if (!items.length) { box.innerHTML = '<span class="empty-note">None yet</span>'; return; }
      items.forEach((it) => {
        const row = document.createElement('div');
        const mb = (it.size / 1048576).toFixed(1) + ' MB';
        if (it.status === 'ready') { const a = document.createElement('a'); a.href = it.url; a.textContent = `${it.created.slice(11)} - ${mb} - download`; row.appendChild(a); }
        else row.textContent = `${it.created.slice(11)} - ${it.status}...`;
        box.appendChild(row);
      });
    } catch (_) {}
  }
})();
