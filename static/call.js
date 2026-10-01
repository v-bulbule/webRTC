// ---------- setup ----------

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = params.get('name') || localStorage.getItem('meet_name') || 'Guest';

if (!roomId) {
  alert('No meeting room specified. Redirecting home.');
  location.href = '/';
}

document.getElementById('roomLabel').textContent = `Meeting code: ${roomId}`;
document.getElementById('roomCodeLabel').textContent = roomId;
document.getElementById('prejoinName').value = myName;

const clientId = crypto.randomUUID();

// Metered TURN/STUN servers (static credentials from the Metered dashboard).
const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '4d07e77dbbd9a93feac09c47',
    credential: 'ktqpVegMFunHprBM',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '4d07e77dbbd9a93feac09c47',
    credential: 'ktqpVegMFunHprBM',
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '4d07e77dbbd9a93feac09c47',
    credential: 'ktqpVegMFunHprBM',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '4d07e77dbbd9a93feac09c47',
    credential: 'ktqpVegMFunHprBM',
  },
];

let localStream = null;
let ws = null;
const peers = {};          // peerId -> RTCPeerConnection
const pendingCandidates = {}; // peerId -> [candidate, ...] queued until remote description is set
const peerNames = {};      // peerId -> display name

// ---------- prejoin ----------

document.getElementById('prejoinJoinBtn').addEventListener('click', joinCall);

async function joinCall() {
  const nameInput = document.getElementById('prejoinName').value.trim();
  const finalName = nameInput || 'Guest';
  localStorage.setItem('meet_name', finalName);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permissions and try again.\n\n' + err.message);
    return;
  }

  document.getElementById('prejoin').style.display = 'none';
  document.getElementById('callPage').style.display = 'flex';

  addTile(clientId, localStream, 'You', true);
  connectSignaling(finalName);
}

// ---------- signaling ----------

function connectSignaling(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${roomId}/${clientId}`);
  if (window.onSignalingReady) window.onSignalingReady(ws);   // recording/transcription feature hook (features.js)

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', name }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'existing-peers':
        for (const peerId of msg.peers) {
          await createPeerConnection(peerId, true);
        }
        break;

      case 'new-peer':
        // Someone new joined; we just wait for their offer.
        break;

      case 'offer': {
        const pc = await createPeerConnection(msg.sender, false);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await flushPendingCandidates(msg.sender);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', target: msg.sender, sdp: pc.localDescription }));
        break;
      }

      case 'answer': {
        const pc = peers[msg.sender];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await flushPendingCandidates(msg.sender);
        }
        break;
      }

      case 'ice-candidate': {
        const pc = peers[msg.sender];
        const candidate = new RTCIceCandidate(msg.candidate);
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidates[msg.sender] = pendingCandidates[msg.sender] || [];
          pendingCandidates[msg.sender].push(candidate);
        }
        break;
      }

      case 'peer-left':
        removePeer(msg.peer);
        break;
    }
  };

  ws.onclose = () => {
    // If the connection drops unexpectedly, let the user know.
  };
}

async function flushPendingCandidates(peerId) {
  const pc = peers[peerId];
  const queued = pendingCandidates[peerId] || [];
  for (const c of queued) {
    await pc.addIceCandidate(c);
  }
  pendingCandidates[peerId] = [];
}

// ---------- peer connections ----------

async function createPeerConnection(peerId, isInitiator) {
  if (peers[peerId]) return peers[peerId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerId] = pc;

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', target: peerId, candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    addTile(peerId, event.streams[0], 'Participant', false);
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', target: peerId, sdp: pc.localDescription }));
  }

  return pc;
}

function removePeer(peerId) {
  const pc = peers[peerId];
  if (pc) {
    pc.close();
    delete peers[peerId];
  }
  delete pendingCandidates[peerId];
  removeTile(peerId);
}

// ---------- video tiles ----------

function addTile(id, stream, label, isLocal) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `<video autoplay playsinline${isLocal ? ' muted' : ''}></video><div class="label">${label}</div>`;
    document.getElementById('videoGrid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  updateParticipantCount();
}

function removeTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateParticipantCount();
}

function updateParticipantCount() {
  const count = document.querySelectorAll('.tile').length;
  document.getElementById('participantCount').textContent = count;
}

// ---------- controls ----------

let micOn = true;
let camOn = true;

document.getElementById('micBtn').addEventListener('click', () => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = document.getElementById('micBtn');
  btn.textContent = micOn ? '🎤' : '🔇';
  btn.classList.toggle('off', !micOn);
});

document.getElementById('camBtn').addEventListener('click', () => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  const btn = document.getElementById('camBtn');
  btn.textContent = camOn ? '📷' : '🚫';
  btn.classList.toggle('off', !camOn);
});

document.getElementById('leaveBtn').addEventListener('click', leaveCall);

async function leaveCall() {
  if (window.beforeLeave) { try { await window.beforeLeave(); } catch (e) { console.warn(e); } }   // finish recording upload first
  Object.keys(peers).forEach(removePeer);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (ws) ws.close();
  location.href = '/';
}

document.getElementById('copyLinkBtn').addEventListener('click', () => {
  const link = `${location.origin}/room.html?room=${roomId}`;
  navigator.clipboard.writeText(link);
  const t = document.getElementById('toast');
  t.textContent = 'Invite link copied';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
});

window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});
