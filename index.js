import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";

const app = express();
const server = createServer(app);

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";
const PORT = process.env.PORT ?? 4000;
const SWEEP_AGE_MS = 2 * 60 * 60 * 1000; // delete files older than 2 hours
const SWEEP_INTERVAL = 60 * 60 * 1000;     // sweep every 1 hour

// ─── Socket.io ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ─── In-memory room store ─────────────────────────────────────────────────────
//
//  rooms = {
//    [roomId]: {
//      users: Map<socketId, { id, name }>
//      hostId: socketId
//      videoUrl: string | null
//      videoFile: string | null      ← filename only, e.g. "1234567890.mp4"
//      videoEndedCount: number       ← how many users have finished watching
//      playerState: {
//        isPlaying: boolean,
//        currentTime: number,
//        updatedAt: timestamp
//      }
//    }
//  }

const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateRoomId = () =>
  Math.random().toString(36).substring(2, 5).toUpperCase() +
  "-" +
  Math.random().toString(36).substring(2, 5).toUpperCase();

const getRoomInfo = (roomId) => {
  const room = rooms[roomId];
  if (!room) return null;
  return {
    roomId,
    users: Array.from(room.users.values()),
    hostId: room.hostId,
    videoUrl: room.videoUrl,
    playerState: room.playerState,
    userCount: room.users.size,
  };
};

// ─── File deletion helpers ────────────────────────────────────────────────────

const deleteFile = (filename) => {
  if (!filename) return;
  const filepath = path.join(UPLOADS_DIR, filename);
  fs.unlink(filepath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error(`[file] failed to delete ${filename}:`, err.message);
    } else {
      console.log(`[file] deleted: ${filename}`);
    }
  });
};

const deleteRoomFile = (roomId) => {
  const room = rooms[roomId];
  if (!room?.videoFile) return;
  deleteFile(room.videoFile);
  room.videoFile = null;
  room.videoUrl = null;
  room.videoEndedCount = 0;
};

// ─── Sweep: safety net for files that were never fully watched ────────────────
// Catches edge cases like crashes, tab closes, or upload-then-leave.
// Runs on startup and every SWEEP_INTERVAL ms.

const UPLOADS_DIR = "uploads";

const sweepUploads = () => {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  const files = fs.readdirSync(UPLOADS_DIR);

  if (files.length === 0) return;

  let deleted = 0;
  files.forEach((filename) => {
    const filepath = path.join(UPLOADS_DIR, filename);
    try {
      const { mtimeMs } = fs.statSync(filepath);
      if (now - mtimeMs > SWEEP_AGE_MS) {
        fs.unlinkSync(filepath);
        deleted++;
        console.log(`[sweep] deleted stale file: ${filename}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[sweep] error checking ${filename}:`, err.message);
    }
  });

  if (deleted > 0) console.log(`[sweep] removed ${deleted} stale file(s)`);
};

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: CLIENT_URL, cedentials: true }));
app.use(express.json());

// ─── Multer ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/webm", "video/ogg", "video/x-matroska"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Invalid file type. Only video files are allowed."));
  },
});

app.use(`/${UPLOADS_DIR}`, express.static(UPLOADS_DIR));

// ─── REST endpoints ───────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

app.post("/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  const url = `${BACKEND_URL}/${UPLOADS_DIR}/${req.file.filename}`;
  console.log(`[upload] ${req.file.originalname} → ${url}`);
  res.json({ url, filename: req.file.filename });
});

app.post("/create-room", (_req, res) => {
  const roomId = generateRoomId();
  rooms[roomId] = {
    users: new Map(),
    hostId: null,
    videoUrl: null,
    videoFile: null,
    videoEndedCount: 0,
    playerState: {
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
    },
  };
  console.log(`[room] created: ${roomId}`);
  res.json({ roomId });
});

app.get("/room/:roomId", (req, res) => {
  const info = getRoomInfo(req.params.roomId);
  if (!info) return res.status(404).json({ error: "Room not found" });
  res.json(info);
});

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith("Invalid file")) {
    return res.status(400).json({ error: err.message });
  }
  console.error("[server error]", err);
  res.status(500).json({ error: "Internal server error" });
});




// ─── Socket.io events ─────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // ── Join room ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId, userName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit("error", { message: "Room not found" }); return; }
    if (room.users.size >= 2) { socket.emit("error", { message: "Room is full (max 2 people)" }); return; }

    const user = { id: socket.id, name: userName ?? "Guest" };
    room.users.set(socket.id, user);
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (!room.hostId) room.hostId = socket.id;

    console.log(`[room] ${user.name} (${socket.id}) joined ${roomId} | users: ${room.users.size}`);

    // ── Video selected: delete old file, store new one ───────────────────
    socket.on("video-selected", ({ roomId, url, filename }) => {
      const room = rooms[roomId];
      if (!room) return;

      // Delete previous video immediately before storing the new one
      if (room.videoFile) {
        console.log(`[file] new video uploaded — deleting old: ${room.videoFile}`);
        deleteRoomFile(roomId);
      }

      room.videoUrl = url;
      room.videoFile = filename ?? null;
      room.videoEndedCount = 0;

      socket.to(roomId).emit("video-selected", { url });
    });

    // ── Video ended: delete when all users finish watching ───────────────
    socket.on("video-ended", ({ roomId }) => {
      const room = rooms[roomId];
      if (!room) return;

      room.videoEndedCount = (room.videoEndedCount ?? 0) + 1;
      console.log(`[player] video ended | room: ${roomId} | ${room.videoEndedCount}/${room.users.size} users done`);

      if (room.videoEndedCount >= room.users.size) {
        console.log(`[file] all users finished watching — deleting: ${room.videoFile}`);
        deleteRoomFile(roomId);
      }
    });

    socket.emit("joined", {
      roomId,
      userId: socket.id,
      isHost: room.hostId === socket.id,
      playerState: room.playerState,
      videoUrl: room.videoUrl,
      users: Array.from(room.users.values()),
    });

    socket.to(roomId).emit("user-joined", {
      user,
      users: Array.from(room.users.values()),
    });
  });

  // ── Player events ──────────────────────────────────────────────────────────
  socket.on("play", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.playerState = { isPlaying: true, currentTime, updatedAt: Date.now() };
    console.log(`[player] play  | room: ${roomId} | time: ${currentTime}`);
    socket.to(roomId).emit("play", { currentTime });
  });

  socket.on("pause", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.playerState = { isPlaying: false, currentTime, updatedAt: Date.now() };
    console.log(`[player] pause | room: ${roomId} | time: ${currentTime}`);
    socket.to(roomId).emit("pause", { currentTime });
  });

  socket.on("seek", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.playerState = { ...room.playerState, currentTime, updatedAt: Date.now() };
    console.log(`[player] seek  | room: ${roomId} | time: ${currentTime}`);
    socket.to(roomId).emit("seek", { currentTime });
  });

  // chat 
  socket.on("chat-message", ({ roomId, text, timestamp }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    console.log(`[chat] ${user.name}: ${text}`);

    // Broadcast to the other user only (sender already added it optimistically)
    socket.to(roomId).emit("chat-message", {
      userId: socket.id,
      userName: user.name,
      text,
      timestamp,
    });
  });

  // ── WebRTC signaling ───────────────────────────────────────────────────────
  socket.on("webrtc-offer", ({ roomId, offer }) => {
    console.log(`[webrtc] offer from ${socket.id}`);
    socket.to(roomId).emit("webrtc-offer", { offer, from: socket.id });
  });

  socket.on("webrtc-answer", ({ roomId, answer, to }) => {
    console.log(`[webrtc] answer from ${socket.id} → ${to}`);
    io.to(to).emit("webrtc-answer", { answer, from: socket.id });
  });

  socket.on("webrtc-ice", ({ _roomId, candidate, to }) => {
    io.to(to).emit("webrtc-ice", { candidate, from: socket.id });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const { roomId } = socket.data;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const user = room.users.get(socket.id);
    room.users.delete(socket.id);

    console.log(`[socket] disconnected: ${socket.id} | room: ${roomId} | remaining: ${room.users.size}`);

    if (room.users.size === 0) {
      // Room is empty — clean up room object but keep the file
      // Sweep will handle stale files after SWEEP_AGE_MS
      delete rooms[roomId];
      console.log(`[room] deleted (empty): ${roomId}`);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value;
      console.log(`[room] new host: ${room.hostId}`);
    }

    socket.to(roomId).emit("user-left", {
      userId: socket.id,
      user,
      newHostId: room.hostId,
      users: Array.from(room.users.values()),
    });
  });
});

// ─── Sweep stale uploads ──────────────────────────────────────────────────────

sweepUploads();
setInterval(sweepUploads, SWEEP_INTERVAL);

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎬 Watch Party server running on http://localhost:${PORT}`);
  console.log(`   Accepting connections from: ${CLIENT_URL}\n`);
});