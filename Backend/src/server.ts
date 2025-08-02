import express from "express";
import { createServer } from "http";
import cors from "cors";
import { Server } from "socket.io";
import { MediasoupManager } from "./mediasoup/MediasoupManager";
import { SignalingServer } from "./webrtc/SignalingServer";
import { hlsRouter } from "./routes/hlsroutes";
import { HLSManager } from "./hls/HLSmanager";

const app = express();
const server = createServer(app);

// CORS Config
app.use(
  cors({
    origin: "http://localhost:5173/",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  })
);

app.use(express.json());

// setting up socket.io
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173/",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  },
});

// Initialize Mediasoup and Signalling
const mediasoupManager = new MediasoupManager();
const signalingServer = new SignalingServer(io, mediasoupManager);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "Working" });
});

// API Routes for room management
app.get("/api/rooms/:roomId/info", async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = mediasoupManager.getRoom(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const streamers = room.getStreamers();
    const viewers = room.getViewers();

    res.json({
      roomId,
      streamers: streamers.length,
      viewers: viewers.length,
      totalParticipants: streamers.length + viewers.length
    });
  } catch (error) {
    console.error("Error getting room info:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// RTP capabilities endpoint
app.get("/api/rtp-capabilities", (req, res) => {
  try {
    const rtpCapabilities = mediasoupManager.getRtpCapabilities();
    res.json({ rtpCapabilities });
  } catch (error) {
    console.error("Error getting RTP capabilities:", error);
    res.status(500).json({ error: "Mediasoup not initialized" });
  }
});

// Mount HLS routes
app.use("/hls", hlsRouter);

const PORT = process.env.PORT || 8000;

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    // Initialize Mediasoup
    await mediasoupManager.initialize();
    console.log("Mediasoup Initialized");

    // Initialize HLS Manager
    const router = mediasoupManager.getRouter();
    if (router) {
      const hlsManager = new HLSManager(router);
      signalingServer.setHLSManager(hlsManager);
      console.log("HLS Manager Initialized");
    }

  } catch (error) {
    console.error("Failed to initialize services:", error);
    process.exit(1);
  }
});