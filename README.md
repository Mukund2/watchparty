# 🍿 WatchParty

A **Teleparty (Netflix Party) clone** — synchronized video watch parties with live chat, built as a self-contained web app. No browser extension required.

Create a room, drop in a YouTube link or a direct video URL, share the room link, and everyone watches **perfectly in sync**. Play, pause, and seek propagate to everyone in the room in real time, with drift correction so people stay locked together even on flaky connections.

## ✨ Features

- **Real-time playback sync** — play / pause / seek broadcast to the whole room over WebSockets, with latency compensation and periodic drift correction.
- **YouTube + direct video** — paste a YouTube link/ID/short, or any `.mp4`/direct video URL.
- **Live chat** — colored usernames, typing indicators, system join/leave messages.
- **Emoji reactions** — floating emoji that everyone in the room sees.
- **Host controls** — first person in is host; optional "host-only control" mode locks playback to the host. Host reassigns automatically if they leave.
- **Shareable rooms** — one-click invite link copy. Rooms auto-expire shortly after everyone leaves.
- **Zero install for guests** — it's just a webpage.

## 🛠 Tech

- **Backend:** Node.js + Express + [Socket.IO](https://socket.io/) — the server is the single source of truth for room playback state.
- **Frontend:** Vanilla JS, YouTube IFrame API, HTML5 `<video>`. No build step.

## 🚀 Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>, click **Create a room**, and share the URL.

For live-reload during development:

```bash
npm run dev
```

Set a custom port with `PORT=8080 npm start`.

## 🧠 How sync works

The server keeps each room's authoritative `{ source, isPlaying, time, updatedAt }`. When a participant plays/pauses/seeks, the action is relayed to everyone else and the server's `time` is updated. Joiners receive the current state (with elapsed time extrapolated from wall-clock), and every client resyncs every 5 seconds — snapping back only if drift exceeds ~1s, so normal playback isn't interrupted.

## 📁 Structure

```
server.js            # Express + Socket.IO, room state + sync logic
public/
  index.html         # Landing — create / join a room
  room.html          # The watch party room
  js/room.js         # Client: player abstraction, sync, chat, reactions
  css/style.css      # Dark Teleparty-style theme
```
