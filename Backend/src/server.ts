import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { MediasoupManager } from "./MediasoupManager";
import { HLSManager } from "./HLSManager";
import { getRoomList, registerSocketHandlers } from "./WebSocket";

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
app.use('/hls', express.static(path.join(process.cwd(), 'public', 'hls')));

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

app.post("/api/rooms/:roomId/join", (req, res) => {
  const { roomId } = req.params;
  const roomList = getRoomList();
  const room = roomList.find((r: any) => r.id === roomId);
  res.json({
    roomExists: !!room,
    participants: room ? room.participants : 0,
  });
});

// HLS streaming endpoints
app.post("/api/hls/start/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { videoProducerId, audioProducerId } = req.body;

    if (!videoProducerId || !audioProducerId) {
      return res.status(400).json({ error: "Video and audio producer IDs required" });
    }

    const streamUrl = await hlsManager.startHLSStream(roomId, videoProducerId, audioProducerId);
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
  
  res.json({ 
    isActive, 
    streamUrl,
    roomId 
  });
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