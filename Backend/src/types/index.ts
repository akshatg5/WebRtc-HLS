export interface StreamerInfo {
  id: string;
  roomId: string;
  isActive: boolean;
}

export interface TransportOptions {
  id: string;
  iceParameters: any;
  iceCandidates: any[];
  dtlsParameters: any;
}

export interface ProducerData {
  id: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
}

export interface ConsumerData {
  id: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
  producerId: string;
}

export interface SocketEvents {
  // Client to Server
  'join-room': (data: { roomId: string; isViewer?: boolean }) => void;
  'create-transport': (data: { direction: 'send' | 'recv' }) => void;
  'connect-transport': (data: { transportId: string; dtlsParameters: any }) => void;
  'produce': (data: { transportId: string; kind: 'audio' | 'video'; rtpParameters: any }) => void;
  'consume': (data: { transportId: string; producerId: string; rtpCapabilities: any }) => void;
  'resume-consumer': (data: { consumerId: string }) => void;

  // Server to Client
  'rtp-capabilities': (data: { rtpCapabilities: any }) => void;
  'transport-created': (data: TransportOptions & { direction: 'send' | 'recv' }) => void;
  'transport-connected': (data: { transportId: string }) => void;
  'produced': (data: { producerId: string }) => void;
  'consumed': (data: ConsumerData) => void;
  'consumer-resumed': (data: { consumerId: string }) => void;
  'new-producer': (data: { producerId: string; userId: string; kind: 'audio' | 'video' }) => void;
  'user-joined': (data: { userId: string; isViewer: boolean }) => void;
  'user-left': (data: { userId: string }) => void;
  'error': (data: { message: string }) => void;
}