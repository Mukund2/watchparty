import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, "public")));

// Create a room and redirect to it.
app.get("/create", (req, res) => {
  const roomId = nanoid(8);
  rooms.set(roomId, makeRoom(roomId));
  res.redirect(`/room.html?room=${roomId}`);
});

// Lightweight existence check used by the join form.
app.get("/api/room/:id", (req, res) => {
  res.json({ exists: rooms.has(req.params.id) });
});

const httpPort = process.env.PORT || 3000;
httpServer.listen(httpPort, () => {
  console.log(`🎬 WatchParty running at http://localhost:${httpPort}`);
});

/* ------------------------------------------------------------------ */
/* Room state                                                          */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();

const PALETTE = [
  "#e50914", "#1db954", "#2196f3", "#ff9800", "#9c27b0",
  "#00bcd4", "#ffeb3b", "#ff4081", "#8bc34a", "#673ab7",
];

function makeRoom(id) {
  return {
    id,
    // Playback state — the single source of truth the server replays to joiners.
    source: null,          // { type: "youtube" | "file", value: "<id or url>" }
    isPlaying: false,
    time: 0,               // seconds, as of `updatedAt`
    updatedAt: Date.now(),
    playbackRate: 1,
    // Everyone-controls vs host-only.
    hostOnly: false,
    hostId: null,
    screenSharerId: null,  // socketId currently sharing their screen (WebRTC), if any
    camOn: new Set(),      // socketIds currently in the webcam call (full mesh)
    users: new Map(),      // socketId -> { name, color }
    colorIdx: 0,
  };
}

/** Current playback position, extrapolating elapsed wall-clock time if playing. */
function projectedTime(room) {
  if (!room.isPlaying) return room.time;
  const elapsed = (Date.now() - room.updatedAt) / 1000;
  return room.time + elapsed * room.playbackRate;
}

function roomStateForClient(room) {
  return {
    source: room.source,
    isPlaying: room.isPlaying,
    time: projectedTime(room),
    playbackRate: room.playbackRate,
    hostOnly: room.hostOnly,
    hostId: room.hostId,
    screenActive: !!room.screenSharerId,
    screenSharerId: room.screenSharerId,
    serverNow: Date.now(),
  };
}

function userList(room) {
  return [...room.users.entries()].map(([id, u]) => ({
    id,
    name: u.name,
    color: u.color,
    isHost: id === room.hostId,
  }));
}

function canControl(room, socketId) {
  return !room.hostOnly || room.hostId === socketId;
}

/* ------------------------------------------------------------------ */
/* Socket.io                                                           */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  let roomId = null;

  socket.on("join", ({ room: rid, name }, ack) => {
    const room = rooms.get(rid);
    if (!room) {
      ack?.({ ok: false, error: "Room not found" });
      return;
    }

    roomId = rid;
    socket.join(rid);

    const color = PALETTE[room.colorIdx % PALETTE.length];
    room.colorIdx++;
    const cleanName = (name || "Guest").toString().slice(0, 24).trim() || "Guest";
    room.users.set(socket.id, { name: cleanName, color });

    // First person in becomes host.
    if (!room.hostId) room.hostId = socket.id;

    ack?.({
      ok: true,
      you: { id: socket.id, name: cleanName, color },
      state: roomStateForClient(room),
      users: userList(room),
    });

    socket.to(rid).emit("system", { text: `${cleanName} joined the party` });
    io.to(rid).emit("users", userList(room));

    // If someone is already sharing their screen, tell the sharer to open a
    // peer connection to this newcomer (the sharer is always the WebRTC offerer).
    if (room.screenSharerId && room.screenSharerId !== socket.id) {
      io.to(room.screenSharerId).emit("viewer-joined", { viewerId: socket.id });
    }
  });

  // Play / pause / seek / rate changes coming from a participant.
  socket.on("control", (action) => {
    const room = rooms.get(roomId);
    if (!room || !canControl(room, socket.id)) return;

    const t = Number(action.time);
    if (Number.isFinite(t)) room.time = Math.max(0, t);
    room.updatedAt = Date.now();

    switch (action.type) {
      case "play":
        room.isPlaying = true;
        break;
      case "pause":
        room.isPlaying = false;
        break;
      case "seek":
        break;
      case "rate":
        if (Number.isFinite(action.rate)) room.playbackRate = action.rate;
        break;
    }

    // Relay to everyone *except* the originator, who already did the action.
    socket.to(roomId).emit("control", {
      ...action,
      time: room.time,
      isPlaying: room.isPlaying,
      serverNow: Date.now(),
    });
  });

  // A participant loaded a new video for the room.
  socket.on("set-source", (source) => {
    const room = rooms.get(roomId);
    if (!room || !canControl(room, socket.id)) return;
    if (!source || !source.type || !source.value) return;

    // Loading a video supersedes any in-progress screen share.
    if (room.screenSharerId) {
      const wasSharer = room.screenSharerId;
      room.screenSharerId = null;
      io.to(roomId).emit("screen-stopped", { sharerId: wasSharer });
    }

    room.source = { type: source.type, value: String(source.value).slice(0, 2000) };
    room.time = 0;
    room.isPlaying = false;
    room.updatedAt = Date.now();

    io.to(roomId).emit("set-source", { source: room.source });
    const u = room.users.get(socket.id);
    io.to(roomId).emit("system", { text: `${u?.name || "Someone"} changed the video` });
  });

  // Periodic drift correction — anyone can request the authoritative time.
  socket.on("resync", (ack) => {
    const room = rooms.get(roomId);
    if (!room) return;
    ack?.(roomStateForClient(room));
  });

  socket.on("toggle-host-only", (value) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.hostOnly = !!value;
    io.to(roomId).emit("host-only", { hostOnly: room.hostOnly });
    io.to(roomId).emit("system", {
      text: room.hostOnly ? "Host enabled host-only control" : "Anyone can control playback now",
    });
  });

  /* ---- Screen sharing (WebRTC; this server only relays signaling) ---- */

  socket.on("screen-start", () => {
    const room = rooms.get(roomId);
    if (!room || !canControl(room, socket.id)) return;

    // One sharer at a time — the new share replaces any current one.
    room.screenSharerId = socket.id;
    room.source = null;
    room.isPlaying = false;
    room.updatedAt = Date.now();

    const u = room.users.get(socket.id);
    io.to(roomId).emit("screen-started", { sharerId: socket.id, name: u?.name || "Someone" });
    io.to(roomId).emit("system", { text: `${u?.name || "Someone"} started sharing their screen` });
  });

  socket.on("screen-stop", () => {
    const room = rooms.get(roomId);
    if (!room || room.screenSharerId !== socket.id) return;
    room.screenSharerId = null;
    io.to(roomId).emit("screen-stopped", { sharerId: socket.id });
    const u = room.users.get(socket.id);
    io.to(roomId).emit("system", { text: `${u?.name || "Someone"} stopped sharing` });
  });

  // Relay WebRTC signaling between two specific peers in the room (screen share).
  socket.on("webrtc-offer", ({ to, sdp }) => {
    if (to) io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });
  socket.on("webrtc-answer", ({ to, sdp }) => {
    if (to) io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });
  socket.on("webrtc-ice", ({ to, candidate }) => {
    if (to) io.to(to).emit("webrtc-ice", { from: socket.id, candidate });
  });

  /* ---- Webcam video call (full-mesh WebRTC; separate from screen share) ---- */

  socket.on("cam-join", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    // Tell the newcomer who's already on camera so it can dial them.
    const existing = [...room.camOn].filter((id) => id !== socket.id);
    socket.emit("cam-existing", { peers: existing });
    room.camOn.add(socket.id);
    // Tell everyone else a new camera came online.
    socket.to(roomId).emit("cam-user-joined", { id: socket.id });
  });

  socket.on("cam-leave", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.camOn.delete(socket.id);
    socket.to(roomId).emit("cam-user-left", { id: socket.id });
  });

  // Per-pair signaling. The peer with the smaller socket id always offers.
  socket.on("cam-offer", ({ to, sdp }) => {
    if (to) io.to(to).emit("cam-offer", { from: socket.id, sdp });
  });
  socket.on("cam-answer", ({ to, sdp }) => {
    if (to) io.to(to).emit("cam-answer", { from: socket.id, sdp });
  });
  socket.on("cam-ice", ({ to, candidate }) => {
    if (to) io.to(to).emit("cam-ice", { from: socket.id, candidate });
  });

  socket.on("chat", (text) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = String(text || "").slice(0, 500).trim();
    if (!msg) return;
    const u = room.users.get(socket.id);
    if (!u) return;
    io.to(roomId).emit("chat", {
      id: socket.id,
      name: u.name,
      color: u.color,
      text: msg,
      ts: Date.now(),
    });
  });

  socket.on("typing", (isTyping) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (!u) return;
    socket.to(roomId).emit("typing", { id: socket.id, name: u.name, isTyping: !!isTyping });
  });

  socket.on("emoji", (emoji) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const e = String(emoji || "").slice(0, 8);
    if (!e) return;
    io.to(roomId).emit("emoji", { emoji: e, id: socket.id });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    const u = room.users.get(socket.id);
    room.users.delete(socket.id);

    if (u) socket.to(roomId).emit("system", { text: `${u.name} left the party` });

    // If the screen-sharer left, end the share for everyone.
    if (room.screenSharerId === socket.id) {
      room.screenSharerId = null;
      socket.to(roomId).emit("screen-stopped", { sharerId: socket.id });
    }

    // If they were on the webcam call, tell others to drop their tile.
    if (room.camOn.has(socket.id)) {
      room.camOn.delete(socket.id);
      socket.to(roomId).emit("cam-user-left", { id: socket.id });
    }

    // Reassign host if the host left.
    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value || null;
    }

    if (room.users.size === 0) {
      // Keep the room around briefly so a quick refresh doesn't nuke it.
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.users.size === 0) rooms.delete(roomId);
      }, 60 * 1000);
    } else {
      io.to(roomId).emit("users", userList(room));
    }
  });
});
