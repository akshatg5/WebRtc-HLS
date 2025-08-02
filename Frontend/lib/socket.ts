// lib/socket.ts
import { io, Socket } from 'socket.io-client';

export interface SocketEvents {
  // Server to Client
  'rtp-capabilities': (data: { rtpCapabilities: any }) => void;
  'transport-created': (data: any) => void;
  'transport-connected': (data: { transportId: string }) => void;
  'produced': (data: { producerId: string }) => void;
  'consumed': (data: any) => void;
  'consumer-resumed': (data: { consumerId: string }) => void;
  'new-producer': (data: { producerId: string; userId: string; kind: string }) => void;
  'user-joined': (data: { userId: string; isViewer: boolean }) => void;
  'user-left': (data: { userId: string }) => void;
  'hls-ready': (data: { hlsUrl: string }) => void;
  'error': (data: { message: string }) => void;
}

class SocketManager {
  private socket: Socket | null = null;

  connect(): Socket {
    if (!this.socket) {
      this.socket = io('http://localhost:8000', {
        withCredentials: true,
      });
    }
    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  getSocket(): Socket | null {
    return this.socket;
  }
}

export const socketManager = new SocketManager();