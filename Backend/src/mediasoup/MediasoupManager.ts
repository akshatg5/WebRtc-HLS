import * as mediasoup from "mediasoup";
import { config } from "../config";

export class MediasoupManager {
  private worker?: mediasoup.types.Worker;
  private router?: mediasoup.types.Router;
  private rooms: Map<string, Room> = new Map();

  async initialize() {
    // create a mediasoup worker
    this.worker = await mediasoup.createWorker(config.mediasoup.worker);

    this.worker.on("died", () => {
      console.error("Mediasoup worker has died,restarting...");
      process.exit(1);
    });

    // create router
    this.router = await this.worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs,
    });

    console.log("Mediasoup worker and router created");
  }

  async createRoom(roomId: string): Promise<Room> {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    if (!this.router) {
      throw new Error("Router is not initialized");
    }

    const room = new Room(roomId, this.router);
    this.rooms.set(roomId, room);

    console.log(`Room ${roomId} created`);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  removeRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.close();
      this.rooms.delete(roomId);
      console.log(`Room ${roomId} removed.`);
    }
  }

  getRtpCapabilities() {
    if (!this.router) {
      throw new Error("Router is not initialzied");
    }
    return this.router.rtpCapabilities;
  }
}

export class Room {
  private peers: Map<string, Peer> = new Map();
  private broadcasters: Map<string, Peer> = new Map(); // for HLS viewers this is used;

  constructor(
    public readonly id: string,
    private router: mediasoup.types.Router
  ) {}

  addPeer(peerId: string, isViewer: boolean = false): Peer {
    const peer = new Peer(peerId, this.router);

    if (isViewer) {
      this.broadcasters.set(peerId, peer);
    } else {
      this.peers.set(peerId, peer);
    }

    console.log(
      `Peer ${peerId} added to room ${this.id} as ${
        isViewer ? "viewer" : "streamer"
      }`
    );
    return peer;
  }

  removePeer(peerId: string) {
    const peer = this.peers.get(peerId) || this.broadcasters.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
      this.broadcasters.delete(peerId);
      console.log(`Peer ${peerId} removed from room ${this.id}`);
    }
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId) || this.broadcasters.get(peerId);
  }

  getStreamers(): Peer[] {
    return Array.from(this.broadcasters.values());
  }

  getViewers(): Peer[] {
    return Array.from(this.broadcasters.values());
  }

  close() {
    // close all the peers
    for (const peer of this.peers.values()) {
      peer.close();
    }

    for (const peer of this.broadcasters.values()) {
      peer.close();
    }

    this.peers.clear();
    this.broadcasters.clear();
  }
}

export class Peer {
  private transports: Map<string, mediasoup.types.Transport> = new Map();
  private producers: Map<string, mediasoup.types.Producer> = new Map();
  private consumers: Map<string, mediasoup.types.Consumer> = new Map();

  constructor(
    public readonly id: string,
    private router: mediasoup.types.Router
  ) {}

  async createWebRtcTransport(direction: "send" | "rev") {
    const transport = await this.router.createWebRtcTransport(
      config.mediasoup.webRtcTransport
    );

    this.transports.set(direction, transport);
    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(transportId: string, dtlsParameters: any) {
    const transport = Array.from(this.transports.values()).find(
      (t) => t.id === transportId
    );
    if (!transport) {
      throw new Error("Transport not found");
    }

    await transport.connect({ dtlsParameters });
  }

  async produce(
    transportId: string,
    kind: mediasoup.types.MediaKind,
    rtpParameters: any
  ) {
    const transport = Array.from(this.transports.values()).find(
      (t) => t.id === transportId
    );
    if (!transport) {
      throw new Error("Transport not found");
    }

    const producer = await (transport as mediasoup.types.WebRtcServer).produce({
      kind,
      rtpParameters,
    });

    this.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      producer.close();
      this.producers.delete(producer.id);
    });

    return producer.id;
  }

  async consume(transportId: string, producerId: string, rtpCapabilities: any) {
    const transport = Array.from(this.transports.values()).find(
      (t) => t.id === transportId
    );
    if (!transport) {
      throw new Error("Transport not found");
    }

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error("Cannot consume");
    }

    const consumer = await (
      transport as mediasoup.types.WebRtcTransport
    ).consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    this.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () => {
      consumer.close();
      this.consumers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: this.consume.rtpParameters,
      producerId: producerId,
    };
  }

  async resumeConsumer(consumerId: string) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new Error("Consumer not found");
    }
    await consumer.resume();
  }

  getProducers(): mediasoup.types.Producer[] {
    return Array.from(this.producers.values());
  }

  close() {
    // Close all transports, producers, and consumers
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }
}
