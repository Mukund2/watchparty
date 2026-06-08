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
  if (activeKind) requestResync();
}, 5000);

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
    if (res.state.source) applyState(res.state);
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

function renderUsers(users) {
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
