import * as mediasoup from "mediasoup";
import { Router, PlainTransport, Producer, Consumer } from "mediasoup/node/lib/types";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";

interface HLSStream {
  roomId: string;
  ffmpegProcess: ffmpeg.FfmpegCommand | null;
  videoTransport: PlainTransport | null;
  audioTransport: PlainTransport | null;
  videoConsumer: Consumer | null;
  audioConsumer: Consumer | null;
  outputDir: string;
}

export class HLSManager {
  private streams = new Map<string, HLSStream>();
  private router: Router;

  constructor(router: Router) {
    this.router = router;
  }

  async startHLSStream(roomId: string, videoProducerId: string, audioProducerId: string): Promise<string> {
    if (this.streams.has(roomId)) {
      return this.getStreamUrl(roomId);
    }

    const outputDir = path.join(process.cwd(), 'public', 'hls', roomId);
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const stream: HLSStream = {
      roomId,
      ffmpegProcess: null,
      videoTransport: null,
      audioTransport: null,
      videoConsumer: null,
      audioConsumer: null,
      outputDir
    };

    try {
      // Create plain transports for video and audio
      stream.videoTransport = await this.createPlainTransport();
      stream.audioTransport = await this.createPlainTransport();

      // Create consumers
      stream.videoConsumer = await stream.videoTransport.consume({
        producerId: videoProducerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: false,
      });

      stream.audioConsumer = await stream.audioTransport.consume({
        producerId: audioProducerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: false,
      });

      // Start FFmpeg process
      await this.startFFmpegProcess(stream);

      this.streams.set(roomId, stream);
      console.log(`HLS stream started for room: ${roomId}`);

      return this.getStreamUrl(roomId);
    } catch (error) {
      console.error(`Failed to start HLS stream for room ${roomId}:`, error);
      this.cleanup(stream);
      throw error;
    }
  }

  private async createPlainTransport(): Promise<PlainTransport> {
    return await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: undefined },
      rtcpMux: false,
      comedia: true,
    });
  }

  private async startFFmpegProcess(stream: HLSStream): Promise<void> {
    const videoPort = stream.videoTransport!.tuple.localPort;
    const audioPort = stream.audioTransport!.tuple.localPort;
    
    const outputPath = path.join(stream.outputDir, 'stream.m3u8');

    // Connect transports to receive RTP
    await stream.videoTransport!.connect({
      ip: '127.0.0.1',
      port: videoPort
    });

    await stream.audioTransport!.connect({
      ip: '127.0.0.1', 
      port: audioPort
    });

    stream.ffmpegProcess = ffmpeg()
      .input(`rtp://127.0.0.1:${videoPort}`)
      .inputOptions([
        '-protocol_whitelist', 'file,rtp,udp',
        '-fflags', '+genpts',
        '-re'
      ])
      .input(`rtp://127.0.0.1:${audioPort}`)
      .inputOptions([
        '-protocol_whitelist', 'file,rtp,udp',
        '-fflags', '+genpts'
      ])
      .outputOptions([
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-x264-params', 'keyint=30:min-keyint=30',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+independent_segments',
        '-hls_segment_filename', path.join(stream.outputDir, 'segment%03d.ts'),
        '-hls_start_number_source', 'datetime'
      ])
      .output(outputPath)
      .on('start', (commandLine : any) => {
        console.log('FFmpeg started:', commandLine);
      })
      .on('error', (err : any) => {
        console.error('FFmpeg error:', err);
      })
      .on('end', () => {
        console.log('FFmpeg ended');
      })
      .on('stderr', (stderrLine : any) => {
        console.log('FFmpeg stderr:', stderrLine);
      });

    stream?.ffmpegProcess?.run();
  }

  stopHLSStream(roomId: string): void {
    const stream = this.streams.get(roomId);
    if (stream) {
      this.cleanup(stream);
      this.streams.delete(roomId);
      console.log(`HLS stream stopped for room: ${roomId}`);
    }
  }

  private cleanup(stream: HLSStream): void {
    if (stream.ffmpegProcess) {
      stream.ffmpegProcess.kill('SIGTERM');
    }

    if (stream.videoConsumer) {
      stream.videoConsumer.close();
    }

    if (stream.audioConsumer) {
      stream.audioConsumer.close();
    }

    if (stream.videoTransport) {
      stream.videoTransport.close();
    }

    if (stream.audioTransport) {
      stream.audioTransport.close();
    }

    // Clean up HLS files
    if (fs.existsSync(stream.outputDir)) {
      fs.rmSync(stream.outputDir, { recursive: true, force: true });
    }
  }

  getStreamUrl(roomId: string): string {
    return `/hls/${roomId}/stream.m3u8`;
  }

  isStreamActive(roomId: string): boolean {
    return this.streams.has(roomId);
  }

  getActiveStreams(): string[] {
    return Array.from(this.streams.keys());
  }
}