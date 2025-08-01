import express from "express";
import { createServer } from "http";
import cors from "cors";
import { Server } from "socket.io";
import { MediasoupManager } from "./mediasoup/MediasoupManager";
import { SignalingServer } from "./webrtc/SignalingServer";

const app = express();
const server = createServer(app);

// CORS Config
app.use(
  cors({
    origin: "http://localhost:5173/",
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json());

// setting up socket.io
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173/",
    methods: ["GET", "POST", "PUT", "DELETE"],
  },
});

// Initialize Mediasoup and Signalling - TODO : Why Signalling
const mediasoupManager = new MediasoupManager();
const signalingServer = new SignalingServer(io, mediasoupManager);

app.get("/health", (req, res) => {
  res.json({ status: "Working" });
});

const PORT = process.env.PORT || 8000;

server.listen(PORT,async () => {
    console.log(`Server running on port ${PORT}`)

    await mediasoupManager.initialize();
    console.log("Mediasoup Intialized")
})