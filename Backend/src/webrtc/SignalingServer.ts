import { Server, Socket } from 'socket.io';
import { MediasoupManager } from '../mediasoup/MediasoupManager';
import { HLSManager } from '../hls/HLSmanager';

interface ClientInfo {
  id: string;
  roomId: string;
  isViewer: boolean;
  socket: Socket;
}

export class SignalingServer {
  private clients: Map<string, ClientInfo> = new Map();
  private hlsManager?: HLSManager; // Made optional with ?

  constructor(
    private io: Server,
    private mediasoupManager: MediasoupManager
  ) {
    // Initialize HLS manager - we'll set this up after mediasoup is ready
    this.setupSocketHandlers();
  }

  setHLSManager(hlsManager: HLSManager) {
    this.hlsManager = hlsManager;
  }

  private setupSocketHandlers() {
    this.io.on('connection', (socket: Socket) => {
      console.log(`Client connected: ${socket.id}`);

      // Join room as streamer or viewer
      socket.on('join-room', async (data: { roomId: string; isViewer?: boolean }) => {
        try {
          const { roomId, isViewer = false } = data;
          
          // Store client info
          this.clients.set(socket.id, {
            id: socket.id,
            roomId,
            isViewer,
            socket
          });

          // Join socket room
          socket.join(roomId);

          // Create or get mediasoup room
          const room = await this.mediasoupManager.createRoom(roomId);
          const peer = room.addPeer(socket.id, isViewer);

          // Send RTP capabilities to client
          socket.emit('rtp-capabilities', {
            rtpCapabilities: this.mediasoupManager.getRtpCapabilities()
          });

          // For viewers (HLS), send the HLS URL if stream is active
          if (isViewer && this.hlsManager) {
            const isHLSActive = this.hlsManager.isHLSActive(roomId);
            if (isHLSActive) {
              socket.emit('hls-ready', {
                hlsUrl: this.hlsManager.getHLSUrl(roomId)
              });
            }
          }

          // Notify other clients about new participant (only for streamers)
          if (!isViewer) {
            socket.to(roomId).emit('user-joined', { 
              userId: socket.id,
              isViewer: false 
            });

            // Send existing producers to new client
            const streamers = room.getStreamers().filter(p => p.id !== socket.id);
            for (const streamer of streamers) {
              const producers = streamer.getProducers();
              for (const producer of producers) {
                socket.emit('new-producer', {
                  producerId: producer.id,
                  userId: streamer.id,
                  kind: producer.kind
                });
              }
            }
          }

          console.log(`Client ${socket.id} joined room ${roomId} as ${isViewer ? 'viewer' : 'streamer'}`);
          
        } catch (error) {
          console.error('Error joining room:', error);
          socket.emit('error', { message: 'Failed to join room' });
        }
      });

      // Create WebRTC transport
      socket.on('create-transport', async (data: { direction: 'send' | 'recv' }) => {
        try {
          const client = this.clients.get(socket.id);
          if (!client) {
            throw new Error('Client not found');
          }

          const room = this.mediasoupManager.getRoom(client.roomId);
          if (!room) {
            throw new Error('Room not found');
          }

          const peer = room.getPeer(socket.id);
          if (!peer) {
            throw new Error('Peer not found');
          }

          const transportOptions = await peer.createWebRtcTransport(data.direction);
          
          socket.emit('transport-created', {
            direction: data.direction,
            ...transportOptions
          });

        } catch (error) {
          console.error('Error creating transport:', error);
          socket.emit('error', { message: 'Failed to create transport' });
        }
      });

      // Connect transport
      socket.on('connect-transport', async (data: { 
        transportId: string; 
        dtlsParameters: any;
      }) => {
        try {
          const client = this.clients.get(socket.id);
          if (!client) throw new Error('Client not found');

          const room = this.mediasoupManager.getRoom(client.roomId);
          if (!room) throw new Error('Room not found');

          const peer = room.getPeer(socket.id);
          if (!peer) throw new Error('Peer not found');

          await peer.connectTransport(data.transportId, data.dtlsParameters);
          
          socket.emit('transport-connected', { transportId: data.transportId });

        } catch (error) {
          console.error('Error connecting transport:', error);
          socket.emit('error', { message: 'Failed to connect transport' });
        }
      });

      // Produce media
      socket.on('produce', async (data: {
        transportId: string;
        kind: 'audio' | 'video';
        rtpParameters: any;
      }) => {
        try {
          const client = this.clients.get(socket.id);
          if (!client) throw new Error('Client not found');

          const room = this.mediasoupManager.getRoom(client.roomId);
          if (!room) throw new Error('Room not found');

          const peer = room.getPeer(socket.id);
          if (!peer) throw new Error('Peer not found');

          const producerId = await peer.produce(
            data.transportId, 
            data.kind, 
            data.rtpParameters
          );

          socket.emit('produced', { producerId });

          // Notify other clients about new producer (except viewers for HLS)
          socket.to(client.roomId).emit('new-producer', {
            producerId,
            userId: socket.id,
            kind: data.kind
          });

          // Check if we should start HLS for this room
          await this.checkAndStartHLS(client.roomId);

        } catch (error) {
          console.error('Error producing:', error);
          socket.emit('error', { message: 'Failed to produce' });
        }
      });

      // Consume media
      socket.on('consume', async (data: {
        transportId: string;
        producerId: string;
        rtpCapabilities: any;
      }) => {
        try {
          const client = this.clients.get(socket.id);
          if (!client) throw new Error('Client not found');

          const room = this.mediasoupManager.getRoom(client.roomId);
          if (!room) throw new Error('Room not found');

          const peer = room.getPeer(socket.id);
          if (!peer) throw new Error('Peer not found');

          const consumerData = await peer.consume(
            data.transportId,
            data.producerId,
            data.rtpCapabilities
          );

          socket.emit('consumed', consumerData);

        } catch (error) {
          console.error('Error consuming:', error);
          socket.emit('error', { message: 'Failed to consume' });
        }
      });

      // Resume consumer
      socket.on('resume-consumer', async (data: { consumerId: string }) => {
        try {
          const client = this.clients.get(socket.id);
          if (!client) throw new Error('Client not found');

          const room = this.mediasoupManager.getRoom(client.roomId);
          if (!room) throw new Error('Room not found');

          const peer = room.getPeer(socket.id);
          if (!peer) throw new Error('Peer not found');

          await peer.resumeConsumer(data.consumerId);
          
          socket.emit('consumer-resumed', { consumerId: data.consumerId });

        } catch (error) {
          console.error('Error resuming consumer:', error);
          socket.emit('error', { message: 'Failed to resume consumer' });
        }
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        const client = this.clients.get(socket.id);
        if (client) {
          const room = this.mediasoupManager.getRoom(client.roomId);
          if (room) {
            room.removePeer(socket.id);
            
            // Notify other clients
            socket.to(client.roomId).emit('user-left', { 
              userId: socket.id 
            });

            // Check if room is empty and clean up
            const streamers = room.getStreamers();
            const viewers = room.getViewers();
            
            if (streamers.length === 0 && viewers.length === 0) {
              // Stop HLS if no one is left
              if (this.hlsManager) {
                await this.hlsManager.stopHLSForRoom(client.roomId);
              }
              this.mediasoupManager.removeRoom(client.roomId);
            } else if (streamers.length === 0 && this.hlsManager) {
              // Stop HLS if no streamers left
              await this.hlsManager.stopHLSForRoom(client.roomId);
            }
          }
          
          this.clients.delete(socket.id);
        }
      });
    });
  }

  private async checkAndStartHLS(roomId: string) {
    if (!this.hlsManager) return;

    const room = this.mediasoupManager.getRoom(roomId);
    if (!room) return;

    // Check if HLS is already active
    if (this.hlsManager.isHLSActive(roomId)) return;

    // Get all producers from all streamers
    const streamers = room.getStreamers();
    const allProducers = streamers.flatMap(streamer => streamer.getProducers());

    // Start HLS if we have producers
    if (allProducers.length > 0) {
      const success = await this.hlsManager.startHLSForRoom(roomId, allProducers);
      
      if (success) {
        // Notify all viewers in the room about HLS availability
        this.io.to(roomId).emit('hls-ready', {
          hlsUrl: this.hlsManager.getHLSUrl(roomId)
        });
      }
    }
  }
}