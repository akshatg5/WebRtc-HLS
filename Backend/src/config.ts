import * as mediasoup from 'mediasoup';

export const config = {
  // Mediasoup settings
  mediasoup: {
    worker: {
      logLevel: 'warn' as mediasoup.types.WorkerLogLevel,
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
      ] as mediasoup.types.WorkerLogTag[],
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio' as mediasoup.types.MediaKind,
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video' as mediasoup.types.MediaKind,
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as mediasoup.types.MediaKind,
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ] as mediasoup.types.RtpCodecCapability[],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: '127.0.0.1',
          // Remove announcedIp entirely or set it to undefined
          // announcedIp: undefined, // This is optional since undefined is the default
        },
      ],
      enableUdp: true,
      enableTcp: true,
      // Removed invalid properties: maxIncomingBitrate, initialAvailableOutgoingBitrate
    },
  },
  
  // HLS settings
  hls: {
    outputPath: './hls-output',
    segmentDuration: 2,
    playlistLength: 6,
  }
};