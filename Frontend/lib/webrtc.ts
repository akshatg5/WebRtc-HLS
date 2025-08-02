// lib/webrtc.ts
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';

export class WebRTCManager {
  private device: Device | null = null;
  private socket: Socket;
  private sendTransport: any = null;
  private recvTransport: any = null;
  private producers: Map<string, any> = new Map();
  private consumers: Map<string, any> = new Map();

  constructor(socket: Socket) {
    this.socket = socket;
  }

  async initialize() {
    // Import mediasoup-client dynamically
    const mediasoupClient = await import('mediasoup-client');
    this.device = new mediasoupClient.Device();

    // Get RTP capabilities from server
    return new Promise((resolve) => {
      this.socket.emit('join-room', { roomId: 'test-room', isViewer: false });
      
      this.socket.on('rtp-capabilities', async (data) => {
        await this.device!.load({ routerRtpCapabilities: data.rtpCapabilities });
        resolve(this.device);
      });
    });
  }

  async createSendTransport() {
    return new Promise((resolve) => {
      this.socket.emit('create-transport', { direction: 'send' });
      
      this.socket.on('transport-created', async (data) => {
        if (data.direction === 'send') {
          this.sendTransport = this.device!.createSendTransport(data);
          
          this.sendTransport.on('connect', ({ dtlsParameters }: any, callback: any) => {
            this.socket.emit('connect-transport', {
              transportId: this.sendTransport.id,
              dtlsParameters
            });
            
            this.socket.once('transport-connected', () => {
              callback();
            });
          });

          this.sendTransport.on('produce', ({ kind, rtpParameters }: any, callback: any) => {
            this.socket.emit('produce', {
              transportId: this.sendTransport.id,
              kind,
              rtpParameters
            });
            
            this.socket.once('produced', (data: any) => {
              callback({ id: data.producerId });
            });
          });

          resolve(this.sendTransport);
        }
      });
    });
  }

  async createRecvTransport() {
    return new Promise((resolve) => {
      this.socket.emit('create-transport', { direction: 'recv' });
      
      this.socket.on('transport-created', async (data) => {
        if (data.direction === 'recv') {
          this.recvTransport = this.device!.createRecvTransport(data);
          
          this.recvTransport.on('connect', ({ dtlsParameters }: any, callback: any) => {
            this.socket.emit('connect-transport', {
              transportId: this.recvTransport.id,
              dtlsParameters
            });
            
            this.socket.once('transport-connected', () => {
              callback();
            });
          });

          resolve(this.recvTransport);
        }
      });
    });
  }

  async produce(stream: MediaStream) {
    const tracks = stream.getTracks();
    
    for (const track of tracks) {
      const producer = await this.sendTransport.produce({ track });
      this.producers.set(producer.kind, producer);
    }
  }

  async consume(producerId: string) {
    this.socket.emit('consume', {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device!.rtpCapabilities
    });

    return new Promise((resolve) => {
      this.socket.once('consumed', async (data) => {
        const consumer = await this.recvTransport.consume(data);
        this.consumers.set(consumer.id, consumer);
        
        this.socket.emit('resume-consumer', { consumerId: consumer.id });
        resolve(consumer);
      });
    });
  }
}