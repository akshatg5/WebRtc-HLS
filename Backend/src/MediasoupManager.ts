import * as mediasoup from "mediasoup";
import {
  Worker,
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  MediaKind,
  RtpParameters,
  RtpCapabilities,
  DtlsParameters,
} from "mediasoup/node/lib/types";

export class MediasoupManager {
  private worker: Worker | null = null;
  private router: Router | null = null;
  private transports = new Map<string, WebRtcTransport>();
  private producers = new Map<string, { producer: Producer; peerId: string }>();
  private consumers = new Map<string, { consumer: Consumer; peerId: string }>();

  private readonly mediaCodecs = [
    {
      kind: "audio" as MediaKind,
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: "video" as MediaKind,
      mimeType: "video/VP8",
      clockRate: 90000,
      parameters: {
        "x-google-start-bitrate": 1000,
      },
    },
    {
      kind: "video" as MediaKind,
      mimeType: "video/VP9",
      clockRate: 90000,
      parameters: {
        "profile-id": 2,
        "x-google-start-bitrate": 1000,
      },
    },
    {
      kind: "video" as MediaKind,
      mimeType: "video/h264",
      clockRate: 90000,
      parameters: {
        "packetization-mode": 1,
        "profile-level-id": "4d0032",
        "level-asymmetry-allowed": 1,
        "x-google-start-bitrate": 1000,
      },
    },
  ];

  private readonly webRtcTransportOptions = {
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1",
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  };

  async initialize(): Promise<void> {
    try {
      this.worker = await this.createWorker();
      this.router = await this.createRouter();
      console.log("MediaSoup initialized successfully");
    } catch (error) {
      console.error("Failed to initialize MediaSoup:", error);
      throw error;
    }
  }

  getRouter(): Router {
    if (!this.router) {
      throw new Error("Router not initialized");
    }
    return this.router;
  }

  private async createWorker(): Promise<Worker> {
    const worker = await mediasoup.createWorker({
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    });

    console.log(`MediaSoup worker created with PID: ${worker.pid}`);

    worker.on("died", (error: Error) => {
      console.error("MediaSoup worker died:", error);
      setTimeout(() => process.exit(1), 2000);
    });

    return worker;
  }

  private async createRouter(): Promise<Router> {
    if (!this.worker) {
      throw new Error("Worker not initialized");
    }

    const router = await this.worker.createRouter({
      mediaCodecs: this.mediaCodecs,
    });

    console.log("MediaSoup router created");
    return router;
  }

  async getRtpCapabilities(): Promise<RtpCapabilities> {
    if (!this.router) {
      throw new Error("Router not initialized");
    }
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(): Promise<WebRtcTransport> {
    if (!this.router) {
      throw new Error("Router not initialized");
    }

    const transport = await this.router.createWebRtcTransport(
      this.webRtcTransportOptions
    );

    this.transports.set(transport.id, transport);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
        this.transports.delete(transport.id);
      }
    });

    transport.on("routerclose", () => {
      console.log("Transport router closed");
      this.transports.delete(transport.id);
    });

    console.log(`WebRTC transport created: ${transport.id}`);
    return transport;
  }

  async connectTransport(
    transportId: string,
    dtlsParameters: DtlsParameters
  ): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }

    await transport.connect({ dtlsParameters });
    console.log(`Transport connected: ${transportId}`);
  }

  async produce(
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
    appData: any,
    peerId?: string
  ): Promise<Producer> {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData,
    });

    this.producers.set(producer.id, {
      producer,
      peerId: peerId || "unknown",
    });

    producer.on("transportclose", () => {
      console.log(`Producer transport closed: ${producer.id}`);
      this.producers.delete(producer.id);
    });

    console.log(`Producer created: ${producer.id} (${kind})`);
    return producer;
  }

  async consume(
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    peerId?: string
  ): Promise<Consumer> {
    if (!this.router) {
      throw new Error("Router not initialized");
    }

    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport not found: ${transportId}`);
    }

    const producerData = this.producers.get(producerId);
    if (!producerData) {
      throw new Error(`Producer not found: ${producerId}`);
    }

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error("Cannot consume this producer");
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    this.consumers.set(consumer.id, {
      consumer,
      peerId: peerId || "unknown",
    });

    consumer.on("transportclose", () => {
      console.log(`Consumer transport closed: ${consumer.id}`);
      this.consumers.delete(consumer.id);
    });

    consumer.on("producerclose", () => {
      console.log(`Consumer producer closed: ${consumer.id}`);
      this.consumers.delete(consumer.id);
    });

    console.log(`Consumer created: ${consumer.id}`);
    return consumer;
  }

  async resumeConsumer(consumerId: string): Promise<void> {
    const consumerData = this.consumers.get(consumerId);
    if (!consumerData) {
      throw new Error(`Consumer not found: ${consumerId}`);
    }

    await consumerData.consumer.resume();
    console.log(`Consumer resumed: ${consumerId}`);
  }

  cleanupPeerResources(peerId: string): void {
    // Clean up producers
    for (const [id, data] of this.producers.entries()) {
      if (data.peerId === peerId) {
        data.producer.close();
        this.producers.delete(id);
        console.log(`Cleaned up producer: ${id} for peer: ${peerId}`);
      }
    }

    // Clean up consumers
    for (const [id, data] of this.consumers.entries()) {
      if (data.peerId === peerId) {
        data.consumer.close();
        this.consumers.delete(id);
        console.log(`Cleaned up consumer: ${id} for peer: ${peerId}`);
      }
    }
  }

  getStats(): {
    transports: number;
    producers: number;
    consumers: number;
  } {
    return {
      transports: this.transports.size,
      producers: this.producers.size,
      consumers: this.consumers.size,
    };
  }
}
