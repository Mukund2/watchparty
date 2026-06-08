/* WatchParty room client — keeps playback locked across everyone + chat. */

const params = new URLSearchParams(location.search);
const roomId = params.get("room");
if (!roomId) location.href = "/";

const socket = io();

let me = null;            // { id, name, color }
let isHost = false;
let hostOnly = false;

// Drift tolerance: only correct local playback if we're off by more than this.
const SYNC_TOLERANCE = 1.0; // seconds

/* ------------------------------------------------------------------ */
/* Player abstraction — wraps either a YouTube player or <video>.      */
/* ------------------------------------------------------------------ */

let activeKind = null;     // "youtube" | "file" | null
let yt = null;             // YT.Player instance
let ytReady = false;
let pendingSource = null;  // source queued before YT API finished loading
const fileVideo = document.getElementById("fileVideo");

// When we apply a remote action locally we must not echo it back to the server.
let suppressEvents = false;

function withSuppressed(fn) {
  suppressEvents = true;
  try { fn(); } finally {
    // Release on next tick so the player's own event has fired first.
    setTimeout(() => { suppressEvents = false; }, 250);
  }
}

// YouTube IFrame API calls this global when ready.
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player("player", {
    height: "100%",
    width: "100%",
    playerVars: { autoplay: 0, modestbranding: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingSource) { applySource(pendingSource); pendingSource = null; }
      },
      onStateChange: onYtStateChange,
    },
  });
};

let lastYtState = -1;
function onYtStateChange(e) {
  if (suppressEvents || activeKind !== "youtube") return;
  const t = yt.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING && lastYtState !== YT.PlayerState.PLAYING) {
    emitControl({ type: "play", time: t });
  } else if (e.data === YT.PlayerState.PAUSED) {
    emitControl({ type: "pause", time: t });
  }
  lastYtState = e.data;
}

/* ---- direct <video> events ---- */
fileVideo.addEventListener("play", () => {
  if (suppressEvents || activeKind !== "file") return;
  emitControl({ type: "play", time: fileVideo.currentTime });
});
fileVideo.addEventListener("pause", () => {
  if (suppressEvents || activeKind !== "file") return;
  emitControl({ type: "pause", time: fileVideo.currentTime });
});
fileVideo.addEventListener("seeked", () => {
  if (suppressEvents || activeKind !== "file") return;
  emitControl({ type: "seek", time: fileVideo.currentTime });
});

/* ---- unified player ops ---- */
function playerPlay() {
  if (activeKind === "youtube" && ytReady) yt.playVideo();
  else if (activeKind === "file") fileVideo.play().catch(() => {});
}
function playerPause() {
  if (activeKind === "youtube" && ytReady) yt.pauseVideo();
  else if (activeKind === "file") fileVideo.pause();
}
function playerSeek(t) {
  if (activeKind === "youtube" && ytReady) yt.seekTo(t, true);
  else if (activeKind === "file") fileVideo.currentTime = t;
}
function playerTime() {
  if (activeKind === "youtube" && ytReady) return yt.getCurrentTime() || 0;
  if (activeKind === "file") return fileVideo.currentTime || 0;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Source parsing — turn user input into { type, value }.             */
/* ------------------------------------------------------------------ */

function parseSource(input) {
  const s = input.trim();
  if (!s) return null;

  // YouTube URL forms.
  const ytPatterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const re of ytPatterns) {
    const m = s.match(re);
    if (m) return { type: "youtube", value: m[1] };
  }
  // Bare 11-char YouTube id.
  if (/^[\w-]{11}$/.test(s)) return { type: "youtube", value: s };

  // Otherwise treat as a direct video URL.
  if (/^https?:\/\//.test(s)) return { type: "file", value: s };

  return null;
}

function applySource(source) {
  if (!source) return;
  document.getElementById("emptyState").style.display = "none";
  // A real video supersedes any screen-share view.
  document.getElementById("screenVideo").hidden = true;
  document.getElementById("screenWaiting").hidden = true;

  if (source.type === "youtube") {
    activeKind = "youtube";
    fileVideo.hidden = true;
    document.getElementById("player").style.display = "block";
    if (!ytReady) { pendingSource = source; return; }
    withSuppressed(() => yt.cueVideoById(source.value));
  } else {
    activeKind = "file";
    document.getElementById("player").style.display = "none";
    fileVideo.hidden = false;
    withSuppressed(() => { fileVideo.src = source.value; fileVideo.load(); });
  }
}

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */

function emitControl(action) {
  if (hostOnly && !isHost) {
    // Non-hosts can't drive; snap back to authoritative state.
    requestResync();
    toast("Only the host can control playback");
    return;
  }
  socket.emit("control", action);
}

// Apply authoritative state (from join or resync) to the local player.
function applyState(state) {
  if (state.source && (!activeKind || sourceChanged(state.source))) {
    applySource(state.source);
  }
  hostOnly = state.hostOnly;
  reflectHostOnly();

  // Account for network latency since the server stamped the state.
  const latency = (Date.now() - state.serverNow) / 1000;
  const target = state.isPlaying ? state.time + Math.max(0, latency) : state.time;

  // Defer until the player can accept seeks.
  const apply = () => {
    withSuppressed(() => {
      playerSeek(target);
      if (state.isPlaying) playerPlay();
      else playerPause();
    });
  };
  if (activeKind === "youtube" && !ytReady) {
    pendingApply = apply;
  } else {
    setTimeout(apply, 300);
  }
}

let pendingApply = null;
let lastSourceValue = null;
function sourceChanged(source) {
  const v = source.type + ":" + source.value;
  if (v !== lastSourceValue) { lastSourceValue = v; return true; }
  return false;
}

function requestResync() {
  socket.emit("resync", (state) => {
    if (!state || !state.source) return;
    const target = state.isPlaying
      ? state.time + Math.max(0, (Date.now() - state.serverNow) / 1000)
      : state.time;
    const drift = Math.abs(playerTime() - target);
    if (drift > SYNC_TOLERANCE) {
      withSuppressed(() => playerSeek(target));
    }
  });
}

/* ---- socket handlers ---- */

socket.on("connect", () => { /* join happens after name chosen */ });

socket.on("control", (action) => {
  withSuppressed(() => {
    if (typeof action.time === "number") {
      const latency = (Date.now() - (action.serverNow || Date.now())) / 1000;
      const target = action.isPlaying ? action.time + Math.max(0, latency) : action.time;
      if (Math.abs(playerTime() - target) > 0.4) playerSeek(target);
    }
    if (action.type === "play") playerPlay();
    else if (action.type === "pause") playerPause();
  });
});

socket.on("set-source", ({ source }) => {
  lastSourceValue = source.type + ":" + source.value;
  applySource(source);
});

socket.on("users", (users) => renderUsers(users));

socket.on("host-only", ({ hostOnly: v }) => { hostOnly = v; reflectHostOnly(); });

socket.on("chat", (msg) => addMessage(msg));
socket.on("system", ({ text }) => addSystem(text));

socket.on("typing", ({ id, name, isTyping }) => updateTyping(id, name, isTyping));

socket.on("emoji", ({ emoji }) => floatEmoji(emoji));

/* ------------------------------------------------------------------ */
/* Periodic drift correction                                          */
/* ------------------------------------------------------------------ */

setInterval(() => {
  // Screen shares are live — there's no timeline to drift-correct.
  if (activeKind && activeKind !== "screen") requestResync();
}, 5000);

/* ------------------------------------------------------------------ */
/* Screen sharing (WebRTC mesh; the server only relays signaling)      */
/* ------------------------------------------------------------------ */

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const screenVideo = document.getElementById("screenVideo");
let localScreenStream = null;
let isSharing = false;
const peers = new Map(); // peerId -> { pc, pending: RTCIceCandidate[] }
const screenSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function ensurePeer(peerId) {
  let entry = peers.get(peerId);
  if (entry) return entry;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  entry = { pc, pending: [] };
  peers.set(peerId, entry);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc-ice", { to: peerId, candidate: e.candidate });
  };
  // Viewer side: the sharer's track arrives here.
  pc.ontrack = (e) => {
    screenVideo.srcObject = e.streams[0];
    activeKind = "screen";
    showScreenStage(false);
  };
  return entry;
}

async function flushPending(entry) {
  for (const c of entry.pending) {
    try { await entry.pc.addIceCandidate(c); } catch (_) {}
  }
  entry.pending = [];
}

async function createOfferTo(peerId) {
  if (!localScreenStream) return;
  const { pc } = ensurePeer(peerId);
  localScreenStream.getTracks().forEach((t) => {
    if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, localScreenStream);
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { to: peerId, sdp: offer });
}

async function startScreenShare() {
  if (!screenSupported) { toast("Your browser can't share a screen here"); return; }
  if (hostOnly && !isHost) { toast("Only the host can share right now"); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true, // captures tab audio in Chrome when sharing a tab
    });
  } catch (err) {
    if (err && err.name !== "NotAllowedError") toast("Couldn't start screen share");
    return; // user cancelled the picker
  }

  localScreenStream = stream;
  isSharing = true;
  activeKind = "screen";
  setShareButton(true);

  // Local preview — muted so we don't echo our own audio.
  screenVideo.srcObject = stream;
  screenVideo.muted = true;
  showScreenStage(false);

  // The browser's native "Stop sharing" bar fires this.
  stream.getVideoTracks()[0].addEventListener("ended", stopScreenShare);

  socket.emit("screen-start");
  currentUserIds().filter((id) => id !== me?.id).forEach(createOfferTo);
}

function stopScreenShare() {
  if (!isSharing) return;
  isSharing = false;
  setShareButton(false);
  if (localScreenStream) {
    localScreenStream.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
  }
  teardownPeers();
  screenVideo.srcObject = null;
  activeKind = null;
  socket.emit("screen-stop");
  showEmpty();
}

function teardownPeers() {
  peers.forEach(({ pc }) => { try { pc.close(); } catch (_) {} });
  peers.clear();
}

/* ---- signaling ---- */

socket.on("viewer-joined", ({ viewerId }) => {
  if (isSharing) createOfferTo(viewerId);
});

socket.on("webrtc-offer", async ({ from, sdp }) => {
  // We're a viewer receiving the sharer's offer.
  const entry = ensurePeer(from);
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPending(entry);
  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { to: from, sdp: answer });
  screenVideo.muted = false;
});

socket.on("webrtc-answer", async ({ from, sdp }) => {
  const entry = peers.get(from);
  if (!entry) return;
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPending(entry);
});

socket.on("webrtc-ice", async ({ from, candidate }) => {
  const entry = peers.get(from);
  if (!entry || !candidate) return;
  const c = new RTCIceCandidate(candidate);
  if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
    try { await entry.pc.addIceCandidate(c); } catch (_) {}
  } else {
    entry.pending.push(c); // buffer until remote description is set
  }
});

socket.on("screen-started", ({ sharerId, name }) => {
  if (sharerId === me?.id) return; // we're the sharer
  activeKind = "screen";
  showScreenStage(true);
  document.getElementById("screenWaitingText").textContent = `${name} is sharing their screen`;
});

socket.on("screen-stopped", ({ sharerId }) => {
  teardownPeers();
  screenVideo.srcObject = null;
  if (sharerId === me?.id) { isSharing = false; setShareButton(false); }
  if (activeKind === "screen") { activeKind = null; showEmpty(); }
});

/* ---- visibility helpers ---- */

function showScreenStage(waiting) {
  document.getElementById("emptyState").style.display = "none";
  document.getElementById("player").style.display = "none";
  fileVideo.hidden = true;
  screenVideo.hidden = false;
  document.getElementById("screenWaiting").hidden = !waiting;
}

function showEmpty() {
  screenVideo.hidden = true;
  document.getElementById("screenWaiting").hidden = true;
  document.getElementById("player").style.display = "none";
  fileVideo.hidden = true;
  if (!lastSourceValue) document.getElementById("emptyState").style.display = "flex";
}

function setShareButton(on) {
  const btn = document.getElementById("shareScreenBtn");
  btn.textContent = on ? "🛑 Stop sharing" : "🖥️ Share screen";
  btn.classList.toggle("sharing", on);
}

/* ------------------------------------------------------------------ */
/* Webcam video call (full-mesh WebRTC, FaceTime/Zoom style)           */
/* ------------------------------------------------------------------ */

const camSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const videoTiles = document.getElementById("videoTiles");
let localCamStream = null;
let inCall = false;
let micEnabled = true;
let camEnabled = true;
let tilesOverlaid = false;
const camPeers = new Map(); // peerId -> { pc, pending: RTCIceCandidate[] }

function camEnsurePeer(peerId) {
  let entry = camPeers.get(peerId);
  if (entry) return entry;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  entry = { pc, pending: [] };
  camPeers.set(peerId, entry);

  if (localCamStream) localCamStream.getTracks().forEach((t) => pc.addTrack(t, localCamStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("cam-ice", { to: peerId, candidate: e.candidate });
  };
  pc.ontrack = (e) => upsertTile(peerId, e.streams[0], false);
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) removeCamPeer(peerId);
  };
  return entry;
}

async function camFlush(entry) {
  for (const c of entry.pending) { try { await entry.pc.addIceCandidate(c); } catch (_) {} }
  entry.pending = [];
}

async function camOfferTo(peerId) {
  const { pc } = camEnsurePeer(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("cam-offer", { to: peerId, sdp: offer });
}

function removeCamPeer(peerId) {
  const entry = camPeers.get(peerId);
  if (entry) { try { entry.pc.close(); } catch (_) {} camPeers.delete(peerId); }
  removeTile(peerId);
}

async function startCall() {
  if (!camSupported) { toast("Your browser can't access the camera here"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      // Echo cancellation is what keeps everyone's audio from feeding back.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (_) {
    toast("Couldn't access your camera/mic — check browser permissions");
    return;
  }
  localCamStream = stream;
  inCall = true;
  micEnabled = true;
  camEnabled = true;
  videoTiles.hidden = false;
  upsertTile(me.id, stream, true); // our own tile is always muted (no self-echo)
  reflectCallUI();
  socket.emit("cam-join");
}

function endCall() {
  if (!inCall) return;
  inCall = false;
  socket.emit("cam-leave");
  [...camPeers.keys()].forEach(removeCamPeer);
  if (localCamStream) { localCamStream.getTracks().forEach((t) => t.stop()); localCamStream = null; }
  removeTile(me.id);
  if (tilesOverlaid) setTilesOverlay(false);
  videoTiles.hidden = true;
  reflectCallUI();
}

/* ---- cam signaling. The peer with the smaller socket id always offers. ---- */

socket.on("cam-existing", ({ peers }) => {
  peers.forEach((pid) => {
    camEnsurePeer(pid);
    if (me.id < pid) camOfferTo(pid);
  });
});

socket.on("cam-user-joined", ({ id }) => {
  if (!inCall) return;
  camEnsurePeer(id);
  if (me.id < id) camOfferTo(id);
});

socket.on("cam-offer", async ({ from, sdp }) => {
  const entry = camEnsurePeer(from);
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await camFlush(entry);
  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);
  socket.emit("cam-answer", { to: from, sdp: answer });
});

socket.on("cam-answer", async ({ from, sdp }) => {
  const entry = camPeers.get(from);
  if (!entry) return;
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await camFlush(entry);
});

socket.on("cam-ice", async ({ from, candidate }) => {
  const entry = camPeers.get(from);
  if (!entry || !candidate) return;
  const c = new RTCIceCandidate(candidate);
  if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
    try { await entry.pc.addIceCandidate(c); } catch (_) {}
  } else entry.pending.push(c);
});

socket.on("cam-user-left", ({ id }) => removeCamPeer(id));

/* ---- tiles ---- */

function upsertTile(id, stream, isLocal) {
  let tile = videoTiles.querySelector(`[data-id="${id}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.id = id;
    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    if (isLocal) v.muted = true; // never play our own mic back
    const name = document.createElement("span");
    name.className = "tile-name";
    tile.appendChild(v);
    tile.appendChild(name);
    videoTiles.appendChild(tile);
  }
  const v = tile.querySelector("video");
  if (v.srcObject !== stream) v.srcObject = stream;
  const u = roomUsers.find((x) => x.id === id);
  tile.querySelector(".tile-name").textContent =
    isLocal ? (u?.name ? `${u.name} (you)` : "You") : (u?.name || "Guest");
  if (u) tile.style.setProperty("--tile-accent", u.color);
  videoTiles.hidden = false;
}

function removeTile(id) {
  const tile = videoTiles.querySelector(`[data-id="${id}"]`);
  if (tile) tile.remove();
  if (videoTiles.children.length === 0 && !inCall) videoTiles.hidden = true;
}

function refreshTileNames() {
  if (!videoTiles) return;
  videoTiles.querySelectorAll(".tile").forEach((tile) => {
    const u = roomUsers.find((x) => x.id === tile.dataset.id);
    if (!u) return;
    const isLocal = tile.dataset.id === me?.id;
    tile.querySelector(".tile-name").textContent = isLocal ? `${u.name} (you)` : u.name;
    tile.style.setProperty("--tile-accent", u.color);
  });
}

function setTilesOverlay(on) {
  tilesOverlaid = on;
  const slot = document.getElementById(on ? "tilesOverlaySlot" : "tilesSidebarSlot");
  slot.appendChild(videoTiles);
  videoTiles.classList.toggle("overlay", on);
  document.getElementById("overlayBtn").classList.toggle("active", on);
}

function reflectCallUI() {
  document.getElementById("joinVideoBtn").hidden = inCall;
  document.getElementById("callControls").hidden = !inCall;
  const micBtn = document.getElementById("micBtn");
  const camBtn = document.getElementById("camBtn");
  micBtn.textContent = micEnabled ? "🎤" : "🔇";
  micBtn.classList.toggle("off", !micEnabled);
  micBtn.title = micEnabled ? "Mute mic" : "Unmute mic";
  camBtn.textContent = camEnabled ? "📷" : "🚫";
  camBtn.classList.toggle("off", !camEnabled);
  camBtn.title = camEnabled ? "Turn camera off" : "Turn camera on";
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */

const nameModal = document.getElementById("nameModal");
const app = document.getElementById("app");

document.getElementById("nameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("nameInput").value.trim() || "Guest";
  socket.emit("join", { room: roomId, name }, (res) => {
    if (!res || !res.ok) {
      alert(res?.error || "Could not join room");
      location.href = "/";
      return;
    }
    me = res.you;
    isHost = res.users.find((u) => u.id === me.id)?.isHost || false;
    nameModal.style.display = "none";
    app.hidden = false;
    renderUsers(res.users);
    if (res.state.screenActive) {
      activeKind = "screen";
      const sharer = res.users.find((u) => u.id === res.state.screenSharerId);
      showScreenStage(true);
      document.getElementById("screenWaitingText").textContent =
        `${sharer?.name || "Someone"} is sharing their screen`;
    } else if (res.state.source) {
      applyState(res.state);
    }
    reflectHostOnly();
  });
});

// Prefill a remembered name.
const savedName = localStorage.getItem("wp_name");
if (savedName) document.getElementById("nameInput").value = savedName;
document.getElementById("nameInput").addEventListener("change", (e) =>
  localStorage.setItem("wp_name", e.target.value.trim())
);

document.getElementById("loadBtn").addEventListener("click", loadSource);
document.getElementById("sourceInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadSource();
});
function loadSource() {
  const input = document.getElementById("sourceInput");
  const source = parseSource(input.value);
  if (!source) { toast("Couldn't recognize that link"); return; }
  if (hostOnly && !isHost) { toast("Only the host can change the video"); return; }
  socket.emit("set-source", source);
  input.value = "";
}

const shareScreenBtn = document.getElementById("shareScreenBtn");
if (!screenSupported) shareScreenBtn.style.display = "none";
shareScreenBtn.addEventListener("click", () => {
  if (isSharing) stopScreenShare();
  else startScreenShare();
});

/* ---- video call controls ---- */
const joinVideoBtn = document.getElementById("joinVideoBtn");
if (!camSupported) joinVideoBtn.style.display = "none";
joinVideoBtn.addEventListener("click", startCall);
document.getElementById("leaveVideoBtn").addEventListener("click", endCall);

document.getElementById("micBtn").addEventListener("click", () => {
  if (!localCamStream) return;
  micEnabled = !micEnabled;
  localCamStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  reflectCallUI();
  const tile = videoTiles.querySelector(`[data-id="${me.id}"]`);
  if (tile) tile.classList.toggle("mic-off", !micEnabled);
});

document.getElementById("camBtn").addEventListener("click", () => {
  if (!localCamStream) return;
  camEnabled = !camEnabled;
  localCamStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
  reflectCallUI();
  const tile = videoTiles.querySelector(`[data-id="${me.id}"]`);
  if (tile) tile.classList.toggle("cam-off", !camEnabled);
});

document.getElementById("overlayBtn").addEventListener("click", () => setTilesOverlay(!tilesOverlaid));

/* ---- layout: collapsible chat + theater mode ---- */
const stage = document.querySelector(".stage");
let chatOpen = true;
let theater = false;

function setChat(open) {
  chatOpen = open;
  stage.classList.toggle("no-chat", !open);
  const btn = document.getElementById("chatToggleBtn");
  btn.classList.toggle("active", !open);
  btn.title = open ? "Hide chat" : "Show chat";
  // Keep faces visible when the chat (their home) is hidden.
  if (!open && inCall && !tilesOverlaid) setTilesOverlay(true);
}
document.getElementById("chatToggleBtn").addEventListener("click", () => setChat(!chatOpen));
document.getElementById("chatCloseBtn").addEventListener("click", () => setChat(false));

document.getElementById("theaterBtn").addEventListener("click", () => {
  theater = !theater;
  stage.classList.toggle("theater", theater);
  document.getElementById("theaterBtn").classList.toggle("active", theater);
  if (theater) setChat(false);
  else setChat(true);
});

document.getElementById("inviteBtn").addEventListener("click", async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied! 🔗");
  } catch {
    prompt("Copy this invite link:", url);
  }
});

document.getElementById("hostOnly").addEventListener("change", (e) => {
  socket.emit("toggle-host-only", e.target.checked);
});

// Chat.
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat", text);
  chatInput.value = "";
  socket.emit("typing", false);
});

let typingTimer = null;
chatInput.addEventListener("input", () => {
  socket.emit("typing", true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", false), 1500);
});

// Reaction buttons.
document.querySelectorAll(".reactions button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    socket.emit("emoji", emoji);
    floatEmoji(emoji); // show our own immediately
  });
});

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

let roomUsers = [];
function currentUserIds() {
  return roomUsers.map((u) => u.id);
}

function renderUsers(users) {
  roomUsers = users;
  refreshTileNames();
  isHost = users.find((u) => u.id === me?.id)?.isHost || false;
  const count = users.length;
  document.getElementById("userCount").textContent =
    `${count} watching`;
  const chips = document.getElementById("userChips");
  chips.innerHTML = "";
  users.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = u.color;
    chip.title = u.name + (u.isHost ? " (host)" : "");
    chip.textContent = (u.isHost ? "★ " : "") + u.name;
    chips.appendChild(chip);
  });
  reflectHostOnly();
}

function reflectHostOnly() {
  const wrap = document.getElementById("hostOnlyWrap");
  wrap.hidden = !isHost;
  document.getElementById("hostOnly").checked = hostOnly;
}

const messages = document.getElementById("messages");
function addMessage(msg) {
  const atBottom = isScrolledToBottom();
  const el = document.createElement("div");
  el.className = "msg" + (msg.id === me?.id ? " mine" : "");
  el.innerHTML = `
    <span class="msg-name" style="color:${msg.color}">${escapeHtml(msg.name)}</span>
    <span class="msg-text">${escapeHtml(msg.text)}</span>`;
  messages.appendChild(el);
  if (atBottom || msg.id === me?.id) scrollMessages();
}
function addSystem(text) {
  const atBottom = isScrolledToBottom();
  const el = document.createElement("div");
  el.className = "msg system";
  el.textContent = text;
  messages.appendChild(el);
  if (atBottom) scrollMessages();
}
function isScrolledToBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}
function scrollMessages() {
  messages.scrollTop = messages.scrollHeight;
}

const typingState = new Map();
function updateTyping(id, name, isTyping) {
  if (isTyping) typingState.set(id, name);
  else typingState.delete(id);
  const names = [...typingState.values()];
  const el = document.getElementById("typingIndicator");
  if (names.length === 0) el.textContent = "";
  else if (names.length === 1) el.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
  else el.textContent = "Several people are typing…";
}

function floatEmoji(emoji) {
  const layer = document.getElementById("reactionLayer");
  const el = document.createElement("div");
  el.className = "float-emoji";
  el.textContent = emoji;
  el.style.left = 10 + Math.random() * 80 + "%";
  el.style.fontSize = 28 + Math.random() * 24 + "px";
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

let toastTimer = null;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Run any deferred state application once YouTube becomes ready.
const ytReadyCheck = setInterval(() => {
  if (ytReady && pendingApply) {
    pendingApply();
    pendingApply = null;
    clearInterval(ytReadyCheck);
  }
}, 200);
