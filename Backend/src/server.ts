import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import { MediasoupManager } from "./MediasoupManager";
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

// Initialize MediaSoup Manager
const mediasoupManager = new MediasoupManager();
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

const PORT = process.env.PORT || 8000;

server.listen(PORT, async () => {
  await mediasoupManager.initialize();
  console.log(`Server running on port ${PORT}`);
});
