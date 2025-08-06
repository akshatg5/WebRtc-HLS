import { Server as SocketIOServer, Socket } from "socket.io";
import { MediasoupManager } from "./MediasoupManager";

interface Room {
  id: string;
  peers: Set<string>;
  producers: Map<string, { producerId: string; kind: string; peerId: string ,appData : any}>;
}

const rooms = new Map<string, Room>();
const peers = new Map<string, { roomId: string; socket: Socket }>();

export const registerSocketHandlers = (io: SocketIOServer, mediasoupManager: MediasoupManager) => {
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", async ({ roomId }) => {
      try {
        socket.join(roomId);

        if (!rooms.has(roomId)) {
          rooms.set(roomId, { 
            id: roomId, 
            peers: new Set(),
            producers: new Map()
          });
        }

        const room = rooms.get(roomId)!;
        room.peers.add(socket.id);
        peers.set(socket.id, { roomId, socket });

        socket.to(roomId).emit("peer-joined", { peerId: socket.id });

        const existingPeers = Array.from(room.peers).filter((id) => id !== socket.id);
        socket.emit("existing-peers", { peers: existingPeers });

        // Send existing producers to the new peer
        const existingProducers = Array.from(room.producers.values());
        socket.emit("existing-producers", { producers: existingProducers });

        console.log(`Peer ${socket.id} joined room ${roomId}`);
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    socket.on("get-rtp-capabilities", async (callback) => {
      try {
        const rtpCapabilities = await mediasoupManager.getRtpCapabilities();
        callback({ rtpCapabilities });
      } catch (error) {
        console.error("Error getting RTP capabilities:", error);
        callback({ error: "Failed to get RTP capabilities" });
      }
    });

    socket.on("create-transport", async ({ direction }, callback) => {
      try {
        const transport = await mediasoupManager.createWebRtcTransport();
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
      } catch (error) {
        console.error("Error creating transport:", error);
        callback({ error: "Failed to create transport" });
      }
    });

    socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
      try {
        await mediasoupManager.connectTransport(transportId, dtlsParameters);
        callback({ success: true });
      } catch (error) {
        console.error("Error connecting transport:", error);
        callback({ error: "Failed to connect transport" });
      }
    });

    socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const producer = await mediasoupManager.produce(
          transportId,
          kind,
          rtpParameters,
          appData,
          socket.id
        );

        const peer = peers.get(socket.id);
        if (peer) {
          const room = rooms.get(peer.roomId);
          if (room) {
            room.producers.set(producer.id, {
              producerId: producer.id,
              kind,
              peerId: socket.id,
              appData : appData
            });
          }

          socket.to(peer.roomId).emit("new-producer", {
            producerId: producer.id,
            peerId: socket.id,
            kind,
          });
        }

        callback({ id: producer.id });
      } catch (error) {
        console.error("Error producing:", error);
        callback({ error: "Failed to produce" });
      }
    });

    socket.on("consume", async ({ transportId, producerId, rtpCapabilities }, callback) => {
      try {
        const consumer = await mediasoupManager.consume(
          transportId,
          producerId,
          rtpCapabilities,
          socket.id
        );

        callback({
          params: {
            producerId,
            id: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        });
      } catch (error) {
        console.error("Error consuming:", error);
        callback({ error: "Failed to consume" });
      }
    });

    socket.on("resume-consumer", async ({ consumerId }, callback) => {
      try {
        await mediasoupManager.resumeConsumer(consumerId);
        callback({ success: true });
      } catch (error) {
        console.error("Error resuming consumer:", error);
        callback({ error: "Failed to resume consumer" });
      }
    });

    socket.on("get-room-producers", ({ roomId }, callback) => {
      const room = rooms.get(roomId);
      if (room) {
        const producers = Array.from(room.producers.values());
        callback({ producers });
      } else {
        callback({ producers: [] });
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);

      const peer = peers.get(socket.id);
      if (peer) {
        const room = rooms.get(peer.roomId);
        if (room) {
          room.peers.delete(socket.id);
          
          // Remove producer entries for this peer
          for (const [producerId, producerData] of room.producers.entries()) {
            if (producerData.peerId === socket.id) {
              room.producers.delete(producerId);
            }
          }

          if (room.peers.size === 0) {
            rooms.delete(peer.roomId);
          }
        }

        socket.to(peer.roomId).emit("peer-left", { peerId: socket.id });
      }

      mediasoupManager.cleanupPeerResources(socket.id);
      peers.delete(socket.id);
    });
  });
};

export const getRoomList = () =>
  Array.from(rooms.values()).map((room) => ({
    id: room.id,
    participants: room.peers.size,
    producers: Array.from(room.producers.values()),
  }));

export const getRoomProducers = (roomId: string) => {
  const room = rooms.get(roomId);
  return room ? Array.from(room.producers.values()) : [];
};