// src/server.ts

import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { MediasoupManager } from "./MediasoupManager";
import { HLSManager } from "./HLSManager";
import {
  getRoomList,
  registerSocketHandlers,
  getRoomProducers,
} from "./WebSocket"; // Import getRoomProducers here

type ParticipantInput = { videoProducerId: string; audioProducerId: string };

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Serve static files for HLS
app.use('/hls', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Cache-Control', 'no-cache');
  
  if (req.path.endsWith('.m3u8')) {
    res.type('application/vnd.apple.mpegurl');
  } else if (req.path.endsWith('.ts')) {
    res.type('video/mp2t');
  }
  
  next();
}, express.static(path.join(process.cwd(), 'public', 'hls')));

// Initialize MediaSoup Manager
const mediasoupManager = new MediasoupManager();
let hlsManager: HLSManager;

// Register socket handlers
registerSocketHandlers(io, mediasoupManager);

// REST API
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

app.get("/api/rooms", (req, res) => {
  res.json({ rooms: getRoomList() });
});

// New endpoint to get producers for a specific room (recommended for frontend consumption)
app.get("/api/rooms/:roomId/producers", (req, res) => {
  const { roomId } = req.params;
  const producers = getRoomProducers(roomId); // Use the imported function
  res.json({ producers });
});

app.post("/api/rooms/:roomId/join", (req, res) => {
  const { roomId } = req.params;
  const roomList = getRoomList();
  const room = roomList.find((r: any) => r.id === roomId);
  res.json({
    roomExists: !!room,
    participants: room ? room?.participants : 0, // Corrected to use room.peers.size
  });
});

// HLS streaming endpoints
app.post("/api/hls/start/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;

    // Build participants from current room producers (auto-include all peers with both tracks)
    const roomProducers = getRoomProducers(roomId) as Array<{
      producerId: string; kind: "audio" | "video"; peerId: string; appData?: any;
    }>;

    const byPeer = new Map<string, { video?: string; audio?: string; app?: any }>();
    for (const p of roomProducers) {
      const e = byPeer.get(p.peerId) || {};
      if (p.kind === "video") { e.video = p.producerId; e.app = p.appData; }
      if (p.kind === "audio") { e.audio = p.producerId; }
      byPeer.set(p.peerId, e);
    }

    let participants: ParticipantInput[] = Array.from(byPeer.values())
      .filter(e => e.video && e.audio)
      .slice(0, 4)
      .map(e => ({ videoProducerId: e.video!, audioProducerId: e.audio! }));

    if (participants.length === 0) {
      return res.status(400).json({ error: "No peers with both audio and video tracks found." });
    }

    const streamUrl = await hlsManager.startHLSStream(
      roomId,
      participants
    );
    res.json({ streamUrl, success: true });
  } catch (error) {
    console.error("Error starting HLS stream:", error);
    res.status(500).json({ error: "Failed to start HLS stream" });
  }
});

app.delete("/api/hls/stop/:roomId", (req, res) => {
  try {
    const { roomId } = req.params;
    hlsManager.stopHLSStream(roomId);
    res.json({ success: true });
  } catch (error) {
    console.error("Error stopping HLS stream:", error);
    res.status(500).json({ error: "Failed to stop HLS stream" });
  }
});

app.get("/api/hls/status/:roomId", (req, res) => {
  const { roomId } = req.params;
  const isActive = hlsManager.isStreamActive(roomId);
  const streamUrl = isActive ? hlsManager.getStreamUrl(roomId) : null;

  res.json({ isActive, streamUrl, roomId });
});

app.get("/api/hls/streams", (req, res) => {
  const activeStreams = hlsManager.getActiveStreams();
  res.json({ streams: activeStreams });
});

const PORT = process.env.PORT || 8000;

server.listen(PORT, async () => {
  await mediasoupManager.initialize();
  hlsManager = new HLSManager(mediasoupManager.getRouter());
  console.log(`Server running on port ${PORT}`);
});
