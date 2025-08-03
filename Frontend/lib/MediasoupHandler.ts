// lib/mediasoup-handler.ts
import * as mediasoupClient from 'mediasoup-client';
import { io, Socket } from 'socket.io-client';

type RemoteStreamCallback = (id: string, stream: MediaStream) => void;
type PeerLeftCallback = (id: string) => void;

export class MediasoupHandler {
    private socket: Socket;
    private device: mediasoupClient.types.Device;
    private sendTransport: mediasoupClient.types.Transport | null = null;
    private recvTransport: mediasoupClient.types.Transport | null = null;
    private producers: Map<string, mediasoupClient.types.Producer> = new Map();
    private consumers: Map<string, mediasoupClient.types.Consumer> = new Map();
    private roomId: string = '';

    public onRemoteStream: RemoteStreamCallback = () => {};
    public onPeerLeft: PeerLeftCallback = () => {};

    constructor() {
        // Connect to the Socket.IO server
        this.socket = io('http://localhost:8000'); // backend URL
        this.device = new mediasoupClient.Device();
        this.setupSocketEvents();
    }

    private setupSocketEvents() {
        this.socket.on('connect', () => {
            console.log('✅ Connected to server');
        });

        // Event from server: a new peer has produced a stream
        this.socket.on('new-producer', async ({ peerId, producerId }) => {
            console.log(`✨ New producer available from peer: ${peerId}`);
            await this.consumeStream(peerId, producerId);
        });

        // Event from server: a peer has left
        this.socket.on('peer-left', ({ peerId }) => {
            console.log(`👋 Peer left: ${peerId}`);
            this.onPeerLeft(peerId);
        });
    }

    public async joinRoom(roomId: string) {
        this.roomId = roomId;
        const serverRtpCapabilities = await this.emitWithAck('get-rtp-capabilities');
        await this.device.load({ routerRtpCapabilities: serverRtpCapabilities.rtpCapabilities });

        await this.createRecvTransport();

        const { producerIds } = await this.emitWithAck('join-room', { roomId });
        console.log(`Joined room, existing producers: ${producerIds.length}`);

        // Consume all existing producers
        for (const producerId of producerIds) {
            // Note: We don't have the peerId for existing producers, this is a simplification.
            // A more robust implementation would send a map of { peerId: producerId[] }.
            // For now, we'll use a placeholder peerId.
            await this.consumeStream(`existing-${producerId}`, producerId);
        }
    }

    public async startProducing(track: MediaStreamTrack) {
        if (!this.sendTransport) {
            await this.createSendTransport();
        }
        if (!this.sendTransport) return;

        const producer = await this.sendTransport.produce({ track });
        this.producers.set(producer.id, producer);

        producer.on('trackended', () => {
            console.log('Local track ended');
            this.closeProducer(producer.id);
        });
    }

    public close() {
        this.socket.close();
        this.sendTransport?.close();
        this.recvTransport?.close();
    }
    
    private async createSendTransport() {
        const params = await this.emitWithAck('create-transport', { roomId: this.roomId });
        if (params.error) {
            console.error(params.error);
            return;
        }

        this.sendTransport = this.device.createSendTransport(params);

        this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitWithAck('connect-transport', {
                    roomId: this.roomId,
                    transportId: this.sendTransport?.id,
                    dtlsParameters,
                });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });

        this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            try {
                const { id } = await this.emitWithAck('produce', {
                    roomId: this.roomId,
                    transportId: this.sendTransport?.id,
                    kind,
                    rtpParameters,
                });
                callback({ id });
            } catch (error) {
                errback(error as Error);
            }
        });
    }

    private async createRecvTransport() {
        const params = await this.emitWithAck('create-transport', { roomId: this.roomId });
        if (params.error) {
            console.error(params.error);
            return;
        }

        this.recvTransport = this.device.createRecvTransport(params);

        this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitWithAck('connect-transport', {
                    roomId: this.roomId,
                    transportId: this.recvTransport?.id,
                    dtlsParameters,
                });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });
    }

    private async consumeStream(peerId: string, producerId: string) {
        if (!this.recvTransport) return;

        const { rtpCapabilities } = this.device;
        const data = await this.emitWithAck('consume', {
            roomId: this.roomId,
            transportId: this.recvTransport.id,
            producerId,
            rtpCapabilities,
        });

        if (data.error) {
            console.error('Cannot consume', data.error);
            return;
        }

        const consumer = await this.recvTransport.consume(data);
        this.consumers.set(consumer.id, consumer);

        // Resume the consumer on the server
        this.socket.emit('resume-consumer', { roomId: this.roomId, consumerId: consumer.id });

        const { track } = consumer;
        const stream = new MediaStream([track]);
        this.onRemoteStream(peerId, stream);
    }
    
    private closeProducer(producerId: string) {
        const producer = this.producers.get(producerId);
        producer?.close();
        this.producers.delete(producerId);
    }

    private emitWithAck(event: string, data: any = {}): Promise<any> {
        return new Promise((resolve) => {
            this.socket.emit(event, data, resolve);
        });
    }
}