// ---------- helpers ----------

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function roomLinkFor(roomId) {
  return `${location.origin}/room.html?room=${roomId}`;
}

// pulls a room code out of either a raw code or a full pasted link
function extractRoomCode(value) {
  value = value.trim();
  try {
    const url = new URL(value);
    const param = url.searchParams.get('room');
    if (param) return param;
  } catch (e) {
    // not a URL, treat as a raw code
  }
  return value;
}

function saveName(name) {
  if (name) localStorage.setItem('meet_name', name);
}
function loadName() {
  return localStorage.getItem('meet_name') || '';
}

// ---------- init ----------

document.getElementById('nameInput').value = loadName();

document.getElementById('startBtn').addEventListener('click', async () => {
  const name = document.getElementById('nameInput').value.trim();
  saveName(name);
  const res = await fetch('/api/new-room');
  const data = await res.json();
  location.href = `/room.html?room=${data.room}&name=${encodeURIComponent(name)}`;
});

document.getElementById('joinBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  saveName(name);
  const raw = document.getElementById('codeInput').value.trim();
  if (!raw) { showToast('Enter a meeting link or code first'); return; }
  const code = extractRoomCode(raw);
  location.href = `/room.html?room=${code}&name=${encodeURIComponent(name)}`;
});

document.getElementById('scheduleBtn').addEventListener('click', async () => {
  const title = document.getElementById('titleInput').value.trim() || 'Untitled meeting';
  const time = document.getElementById('timeInput').value;
  const hostName = document.getElementById('nameInput').value.trim();
  if (!time) { showToast('Pick a date & time first'); return; }

  const res = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, time, host_name: hostName })
  });
  if (!res.ok) { showToast('Could not schedule meeting'); return; }

  document.getElementById('titleInput').value = '';
  document.getElementById('timeInput').value = '';
  showToast('Meeting scheduled');
  loadMeetings();
});

async function loadMeetings() {
  const res = await fetch('/api/schedule');
  const meetings = await res.json();
  const list = document.getElementById('meetingList');
  const emptyNote = document.getElementById('emptyNote');
  list.innerHTML = '';

  if (meetings.length === 0) {
    emptyNote.style.display = 'block';
    return;
  }
  emptyNote.style.display = 'none';

  for (const m of meetings) {
    const item = document.createElement('div');
    item.className = 'meeting-item';

    const when = new Date(m.time);
    const whenStr = isNaN(when) ? m.time : when.toLocaleString();

    item.innerHTML = `
      <div class="info">
        <strong>${escapeHtml(m.title)}</strong>
        <span>${whenStr}${m.host_name ? ' · hosted by ' + escapeHtml(m.host_name) : ''}</span>
      </div>
      <div class="actions">
        <button class="btn-secondary copy-btn" data-room="${m.id}">Copy link</button>
        <button class="btn-primary join-btn" data-room="${m.id}">Join</button>
        <button class="btn-secondary del-btn" data-id="${m.id}">Delete</button>
      </div>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(roomLinkFor(btn.dataset.room));
      showToast('Link copied');
    });
  });
  list.querySelectorAll('.join-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = document.getElementById('nameInput').value.trim();
      location.href = `/room.html?room=${btn.dataset.room}&name=${encodeURIComponent(name)}`;
    });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/schedule/${btn.dataset.id}`, { method: 'DELETE' });
      loadMeetings();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

loadMeetings();
