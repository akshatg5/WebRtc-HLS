import * as mediasoup from 'mediasoup';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

interface StreamInfo {
  roomId: string;
  videoProducerId?: string;
  audioProducerId?: string;
  ffmpegProcess?: ChildProcess;
  plainTransport?: mediasoup.types.PlainTransport;
}

export class HLSManager {
  private streams: Map<string, StreamInfo> = new Map();
  private router: mediasoup.types.Router;

  constructor(router: mediasoup.types.Router) {
    this.router = router;
    this.ensureHLSDirectory();
  }

  private async ensureHLSDirectory() {
    try {
      await fs.mkdir(config.hls.outputPath, { recursive: true });
    } catch (error) {
      console.error('Error creating HLS directory:', error);
    }
  }

  async startHLSForRoom(roomId: string, producers: mediasoup.types.Producer[]) {
    try {
      console.log(`Starting HLS for room: ${roomId}`);
      
      const videoProducer = producers.find(p => p.kind === 'video');
      const audioProducer = producers.find(p => p.kind === 'audio');

      if (!videoProducer && !audioProducer) {
        throw new Error('No producers found for HLS');
      }

      // Create plain transport for receiving RTP
      const plainTransport = await this.router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: undefined },
        rtcpMux: false,
        comedia: true,
      });

      const streamInfo: StreamInfo = {
        roomId,
        plainTransport,
        videoProducerId: videoProducer?.id,
        audioProducerId: audioProducer?.id,
      };

      // Create consumers for each producer
      const consumers: mediasoup.types.Consumer[] = [];

      if (videoProducer) {
        const videoConsumer = await plainTransport.consume({
          producerId: videoProducer.id,
          rtpCapabilities: this.router.rtpCapabilities,
          paused: false,
        });
        consumers.push(videoConsumer);
      }

      if (audioProducer) {
        const audioConsumer = await plainTransport.consume({
          producerId: audioProducer.id,
          rtpCapabilities: this.router.rtpCapabilities,
          paused: false,
        });
        consumers.push(audioConsumer);
      }

      // Start FFmpeg process
      const ffmpegProcess = this.startFFmpeg(roomId, plainTransport, consumers);
      streamInfo.ffmpegProcess = ffmpegProcess;

      this.streams.set(roomId, streamInfo);

      console.log(`HLS started for room: ${roomId}`);
      return true;

    } catch (error) {
      console.error(`Error starting HLS for room ${roomId}:`, error);
      return false;
    }
  }

  private startFFmpeg(
    roomId: string,
    plainTransport: mediasoup.types.PlainTransport,
    consumers: mediasoup.types.Consumer[]
  ): ChildProcess {
    const outputPath = path.join(config.hls.outputPath, `${roomId}.m3u8`);
    const segmentPath = path.join(config.hls.outputPath, `${roomId}_%03d.ts`);

    // Build FFmpeg command
    const ffmpegArgs: string[] = [
      '-y', // Overwrite output files
      '-f', 'rtp',
      '-protocol_whitelist', 'file,rtp,udp',
    ];

    // Add inputs for each consumer
    let portOffset = 0;
    consumers.forEach((consumer) => {
      const basePort = plainTransport.tuple.localPort + portOffset;
      const rtcpPort = plainTransport.rtcpTuple?.localPort 
        ? plainTransport.rtcpTuple.localPort + portOffset 
        : basePort + 1;
      
      if (consumer.kind === 'video') {
        ffmpegArgs.push(
          '-i', `rtp://127.0.0.1:${basePort}?rtcpport=${rtcpPort}`
        );
      } else if (consumer.kind === 'audio') {
        ffmpegArgs.push(
          '-i', `rtp://127.0.0.1:${basePort}?rtcpport=${rtcpPort}`
        );
      }
      
      portOffset += 2; // Increment by 2 for each consumer (RTP + RTCP)
    });

    // Output settings
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'hls',
      '-hls_time', config.hls.segmentDuration.toString(),
      '-hls_list_size', config.hls.playlistLength.toString(),
      '-hls_flags', 'delete_segments',
      outputPath
    );

    console.log('Starting FFmpeg with args:', ffmpegArgs.join(' '));

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg process for room ${roomId} exited with code ${code}`);
    });

    ffmpegProcess.on('error', (error) => {
      console.error(`FFmpeg error for room ${roomId}:`, error);
    });

    return ffmpegProcess;
  }

  async stopHLSForRoom(roomId: string) {
    const streamInfo = this.streams.get(roomId);
    if (!streamInfo) {
      return;
    }

    console.log(`Stopping HLS for room: ${roomId}`);

    // Kill FFmpeg process
    if (streamInfo.ffmpegProcess) {
      streamInfo.ffmpegProcess.kill('SIGTERM');
    }

    // Close plain transport
    if (streamInfo.plainTransport) {
      streamInfo.plainTransport.close();
    }

    // Clean up files
    try {
      const hlsFiles = [
        path.join(config.hls.outputPath, `${roomId}.m3u8`),
        ...Array.from({ length: config.hls.playlistLength }, (_, i) => 
          path.join(config.hls.outputPath, `${roomId}_${String(i).padStart(3, '0')}.ts`)
        )
      ];

      for (const file of hlsFiles) {
        try {
          await fs.unlink(file);
        } catch (error) {
          // File might not exist, ignore
        }
      }
    } catch (error) {
      console.error(`Error cleaning up HLS files for room ${roomId}:`, error);
    }

    this.streams.delete(roomId);
    console.log(`HLS stopped for room: ${roomId}`);
  }

  isHLSActive(roomId: string): boolean {
    return this.streams.has(roomId);
  }

  getHLSUrl(roomId: string): string {
    return `/hls/${roomId}.m3u8`;
  }
}