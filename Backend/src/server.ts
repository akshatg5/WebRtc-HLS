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
    const { videoProducerId, audioProducerId } = req.body;

    if (!videoProducerId || !audioProducerId) {
      return res
        .status(400)
        .json({ error: "Video and audio producer IDs required" });
    }

    // Retrieve full producer info, which now includes appData (width/height)
    const roomProducers = getRoomProducers(roomId); // Get producers directly from WebSocket state
    const videoProducerInfo = roomProducers.find(
      (p: any) => p.producerId === videoProducerId
    );
    const audioProducerInfo = roomProducers.find(
      (p: any) => p.producerId === audioProducerId
    );

    if (!videoProducerInfo) {
      return res
        .status(400)
        .json({ error: `Video producer not found for ID: ${videoProducerId}` });
    }
    if (!audioProducerInfo) {
      return res
        .status(400)
        .json({ error: `Audio producer not found for ID: ${audioProducerId}` });
    }

    // Extract width and height from the video producer's appData
    const videoWidth = videoProducerInfo.appData?.width;
    const videoHeight = videoProducerInfo.appData?.height;

    if (
      typeof videoWidth !== "number" ||
      typeof videoHeight !== "number" ||
      videoWidth <= 0 ||
      videoHeight <= 0
    ) {
      console.error(
        `Invalid video dimensions received for room ${roomId}: ${videoWidth}x${videoHeight}`
      );
      return res
        .status(400)
        .json({ error: "Invalid video dimensions received." });
    }
    console.log(
      `Starting HLS for room ${roomId} with video dimensions: ${videoWidth}x${videoHeight}`
    );

    const streamUrl = await hlsManager.startHLSStream(
      roomId,
      videoProducerId,
      audioProducerId,
      videoWidth,
      videoHeight
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
