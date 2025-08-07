import * as mediasoup from "mediasoup";
import {
  Router,
  PlainTransport,
  Producer,
  Consumer,
  RtpParameters,
  RtcpParameters,
} from "mediasoup/node/lib/types";
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

  private async testRTPReception(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const dgram = require("dgram");
      const socket = dgram.createSocket("udp4");
      let packetCount = 0;
      let timeout: NodeJS.Timeout;

      socket.on("message", (msg: Buffer, rinfo: any) => {
        packetCount++;
        console.log(
          `Received RTP packet ${packetCount} on port ${port}, size: ${msg.length} bytes`
        );

        if (packetCount >= 5) {
          clearTimeout(timeout);
          socket.close();
          resolve(true);
        }
      });

      socket.on("error", (err: Error) => {
        console.error(`Socket error on port ${port}:`, err);
        clearTimeout(timeout);
        socket.close();
        resolve(false);
      });

      socket.bind(port, "127.0.0.1", () => {
        console.log(`Listening for RTP packets on port ${port}...`);

        timeout = setTimeout(() => {
          console.log(
            `No RTP packets received on port ${port} after 10 seconds`
          );
          socket.close();
          resolve(false);
        }, 10000);
      });
    });
  }

  async startHLSStream(
    roomId: string,
    videoProducerId: string,
    audioProducerId: string,
    videoWidth: number = 1280,
    videoHeight: number = 720
  ): Promise<string> {
    if (this.streams.has(roomId)) {
      return this.getStreamUrl(roomId);
    }
    const outputDir = path.join(process.cwd(), "public", "hls", roomId);

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
      outputDir,
    };

    try {
      stream.videoTransport = await this.createPlainTransport();
      stream.audioTransport = await this.createPlainTransport();

      stream.videoConsumer = await stream.videoTransport.consume({
        producerId: videoProducerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: false,
      });

      const videoRtpParameters = stream.videoConsumer.rtpParameters;
      console.log(
        "Video PlainTransport Consumer RTP Parameters:",
        JSON.stringify(videoRtpParameters, null, 2)
      );

      stream.audioConsumer = await stream.audioTransport.consume({
        producerId: audioProducerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: false,
      });

      const audioRtpParameters = stream.audioConsumer.rtpParameters;
      console.log(
        "Audio PlainTransport Consumer RTP Parameters:",
        JSON.stringify(audioRtpParameters, null, 2)
      );

      await this.startFFmpegProcess(
        stream,
        videoRtpParameters,
        audioRtpParameters,
        videoWidth,
        videoHeight
      );

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
      listenIp: { ip: "127.0.0.1", announcedIp: undefined },
      rtcpMux: false,
      comedia: false, // Changed to false - we want explicit connection
      enableSctp: false,
      enableSrtp: false,
    });
  }

  private async startFFmpegProcess(
  stream: HLSStream,
  videoRtpParameters: RtpParameters,
  audioRtpParameters: RtpParameters,
  videoWidth: number,
  videoHeight: number
): Promise<void> {
  const ffmpegVideoPort = 20000;
  const ffmpegAudioPort = 20002;
  const ffmpegVideoRtcpPort = ffmpegVideoPort + 1;
  const ffmpegAudioRtcpPort = ffmpegAudioPort + 1;

  const outputPath = path.join(stream.outputDir, "stream.m3u8");

  if (!stream.videoConsumer || !stream.audioConsumer) {
    throw new Error("Consumers are not initialized for FFmpeg setup.");
  }

  console.log("---------------------------");
  console.log("Starting the FFMPEG process");
  console.log("!!!!!!!!!! VIDEO WIDTH : ", videoWidth);
  console.log("!!!!!!!!!! VIDEO HEIGHT : ", videoHeight);
  console.log("---------------------------");

  // Connect transports to FFmpeg ports FIRST
  await stream?.videoTransport?.connect({
    ip: "127.0.0.1",
    port: ffmpegVideoPort,
    rtcpPort: ffmpegVideoRtcpPort,
  });
  console.log(`Video transport connected to ${ffmpegVideoPort}`);

  await stream?.audioTransport?.connect({
    ip: "127.0.0.1",
    port: ffmpegAudioPort,
    rtcpPort: ffmpegAudioRtcpPort,
  });
  console.log(`Audio transport connected to ${ffmpegAudioPort}`);

  // Wait for transports to establish connection
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Test RTP reception
  console.log("Testing RTP reception after transport connection...");
  const videoRtpTest = await this.testRTPReception(ffmpegVideoPort);
  const audioRtpTest = await this.testRTPReception(ffmpegAudioPort);

  console.log(`Video RTP test: ${videoRtpTest ? "PASS" : "FAIL"}`);
  console.log(`Audio RTP test: ${audioRtpTest ? "PASS" : "FAIL"}`);

  if (!videoRtpTest && !audioRtpTest) {
    throw new Error("No RTP streams detected after transport connection");
  }

  if (!videoRtpParameters.encodings || !audioRtpParameters.encodings) {
    throw new Error("Cannot find encodings for videoRtp or audioRtp")
  }

  // Create proper SDP files for RTP streams
  const videoSdpContent = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Video Stream",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=video ${ffmpegVideoPort} RTP/AVP ${videoRtpParameters.codecs[0].payloadType}`,
    `a=rtpmap:${videoRtpParameters.codecs[0].payloadType} ${videoRtpParameters.codecs[0].mimeType.split("/")[1].toUpperCase()}/${videoRtpParameters.codecs[0].clockRate}`,
    `a=sendonly`,
    `a=ssrc:${videoRtpParameters.encodings[0].ssrc}`,
  ].join("\r\n") + "\r\n";

  const audioSdpContent = [
    "v=0", 
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Audio Stream",
    "c=IN IP4 127.0.0.1", 
    "t=0 0",
    `m=audio ${ffmpegAudioPort} RTP/AVP ${audioRtpParameters.codecs[0].payloadType}`,
    `a=rtpmap:${audioRtpParameters.codecs[0].payloadType} ${audioRtpParameters.codecs[0].mimeType.split("/")[1].toUpperCase()}/${audioRtpParameters.codecs[0].clockRate}`,
    `a=sendonly`,
    `a=ssrc:${audioRtpParameters?.encodings[0]?.ssrc}`,
  ].join("\r\n") + "\r\n";

  const videoSdpPath = path.join(stream.outputDir, "video.sdp");
  const audioSdpPath = path.join(stream.outputDir, "audio.sdp");

  fs.writeFileSync(videoSdpPath, videoSdpContent);
  fs.writeFileSync(audioSdpPath, audioSdpContent);

  console.log("SDP files created:");
  console.log("Video SDP:", videoSdpContent);
  console.log("Audio SDP:", audioSdpContent);

  // Start FFmpeg with SDP files and improved settings
  console.log("Starting FFmpeg with SDP files...");
  
  stream.ffmpegProcess = ffmpeg()
    .input(videoSdpPath)
    .inputOptions([
      "-protocol_whitelist", "file,rtp,udp",
      "-fflags", "+genpts",
      "-rw_timeout", "30000000", // 30 second timeout
      "-probesize", "32768",     // Smaller probe size
      "-analyzeduration", "1000000", // 1 second analysis
    ])
    .input(audioSdpPath)
    .inputOptions([
      "-protocol_whitelist", "file,rtp,udp",
      "-fflags", "+genpts", 
      "-rw_timeout", "30000000",
      "-probesize", "32768",
      "-analyzeduration", "1000000",
    ])
    .outputOptions([
      "-y",
      "-map", "0:v:0",
      "-map", "1:a:0", 
      "-c:v", "libx264",
      "-c:a", "aac",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-s", `${videoWidth}x${videoHeight}`,
      "-r", "30",
      "-g", "30", // GOP size
      "-keyint_min", "30",
      "-sc_threshold", "0", // Disable scene change detection
      "-b:v", "1000k",
      "-maxrate", "1200k",
      "-bufsize", "2000k",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-f", "hls",
      "-hls_time", "2", // Shorter segment time for faster startup
      "-hls_list_size", "10",
      "-hls_flags", "delete_segments+independent_segments",
      "-hls_segment_filename", path.join(stream.outputDir, "segment_%03d.ts"),
      "-hls_start_number_source", "datetime",
      "-avoid_negative_ts", "make_zero",
      "-loglevel", "verbose" // More verbose logging
    ])
    .output(outputPath)
    .on("start", (commandLine: string) => {
      console.log("FFmpeg started with command:");
      console.log(commandLine);
    })
    .on("error", (err: Error) => {
      console.error("FFmpeg error:", err.message);
      console.log("FFmpeg failed - stopping HLS stream");
      this.stopHLSStream(stream.roomId);
    })
    .on("end", () => {
      console.log("FFmpeg ended for room:", stream.roomId);
    })
    .on("stderr", (stderrLine: string) => {
      console.log("FFmpeg:", stderrLine.trim());
    });

  // Add a small delay before starting FFmpeg to ensure RTP is flowing
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  stream.ffmpegProcess.run();

  // Check file creation after delay
  setTimeout(() => {
    const manifestPath = path.join(stream.outputDir, "stream.m3u8");
    
    console.log(`\n=== HLS Output Check for room ${stream.roomId} ===`);
    console.log(`Manifest exists: ${fs.existsSync(manifestPath)}`);
    
    if (fs.existsSync(manifestPath)) {
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      console.log(`Manifest content:\n${manifestContent}`);
    }
    
    try {
      const files = fs.readdirSync(stream.outputDir);
      const segmentFiles = files.filter(file => file.startsWith('segment_') && file.endsWith('.ts'));
      console.log(`Segment files found: ${segmentFiles.length}`);
      segmentFiles.forEach(file => {
        const filePath = path.join(stream.outputDir, file);
        const stats = fs.statSync(filePath);
        console.log(`${file}: ${stats.size} bytes`);
      });
    } catch (error) {
      console.log("Error reading directory:", error);
    }
    console.log("=== End HLS Output Check ===\n");
  }, 15000); // Check after 15 seconds
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
      try {
        stream.ffmpegProcess.kill("SIGTERM");
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (stream.ffmpegProcess) {
            stream.ffmpegProcess.kill("SIGKILL");
          }
        }, 5000);
      } catch (error) {
        console.error("Error killing FFmpeg process:", error);
      }
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

    if (fs.existsSync(stream.outputDir)) {
      try {
        fs.rmSync(stream.outputDir, { recursive: true, force: true });
        console.log(`Cleaned up HLS directory: ${stream.outputDir}`);
      } catch (error) {
        console.error("Error cleaning up HLS directory:", error);
      }
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
