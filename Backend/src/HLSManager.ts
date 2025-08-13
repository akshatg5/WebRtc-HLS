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

// Updated interface for multi-participant support
interface HLSParticipant {
  videoTransport: PlainTransport;
  audioTransport: PlainTransport;
  videoConsumer: Consumer;
  audioConsumer: Consumer;
  videoPort: number;
  audioPort: number;
  videoProducerId: string;
  audioProducerId: string;
}

interface HLSStream {
  roomId: string;
  ffmpegProcess: ffmpeg.FfmpegCommand | null;
  participants: HLSParticipant[];
  outputDir: string;
}

interface ParticipantInput {
  videoProducerId: string;
  audioProducerId: string;
}

export class HLSManager {
  private streams = new Map<string, HLSStream>();
  private router: Router;

  constructor(router: Router) {
    this.router = router;
  }

  // Updated startHLSStream method for multi-participant support
  async startHLSStream(
    roomId: string,
    participants: ParticipantInput[],
    videoWidth: number = 1280,
    videoHeight: number = 720
  ): Promise<string> {
    // Validation: Check participant count
    if (participants.length === 0) {
      throw new Error("No participants provided for HLS stream");
    }

    if (participants.length > 4) {
      throw new Error("HLS not supported for more than 4 users. Current participants: " + participants.length);
    }

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
      participants: [],
      outputDir,
    };

    try {
      console.log(`Starting HLS for room ${roomId} with ${participants.length} participants`);

      // Create consumers and transports for each participant
      for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        const basePort = 20000 + (i * 4); // Each participant gets 4 ports (video, video-rtcp, audio, audio-rtcp)
        const videoPort = basePort;
        const audioPort = basePort + 2;

        console.log(`Setting up participant ${i + 1} - Video port: ${videoPort}, Audio port: ${audioPort}`);

        const videoTransport = await this.createPlainTransport();
        const audioTransport = await this.createPlainTransport();

        const videoConsumer = await videoTransport.consume({
          producerId: participant.videoProducerId,
          rtpCapabilities: this.router.rtpCapabilities,
          paused: false,
        });

        const audioConsumer = await audioTransport.consume({
          producerId: participant.audioProducerId,
          rtpCapabilities: this.router.rtpCapabilities,
          paused: false,
        });

        stream.participants.push({
          videoTransport,
          audioTransport,
          videoConsumer,
          audioConsumer,
          videoPort,
          audioPort,
          videoProducerId: participant.videoProducerId,
          audioProducerId: participant.audioProducerId,
        });
      }

      await this.startFFmpegProcessMultiParticipant(
        stream,
        videoWidth,
        videoHeight
      );

      this.streams.set(roomId, stream);
      console.log(`Multi-participant HLS stream started for room: ${roomId}`);

      return this.getStreamUrl(roomId);
    } catch (error) {
      console.error(`Failed to start multi-participant HLS stream started and ready for room ${roomId}:`, error);
      this.cleanup(stream);
      throw error;
    }
  }

  private async waitForFirstSegment(stream: HLSStream, timeoutMs: number = 30000): Promise<void> {
    const manifestPath = path.join(stream.outputDir, "stream.m3u8");
    const startTime = Date.now();
  
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Check if we've exceeded timeout
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for HLS manifest after ${timeoutMs}ms`));
          return;
        }
  
        // Check if manifest file exists and has content
        if (fs.existsSync(manifestPath)) {
          try {
            const manifestContent = fs.readFileSync(manifestPath, 'utf8');
            
            // Check if manifest has at least one segment
            if (manifestContent.includes('.ts')) {
              // Check if the first segment file actually exists
              const segmentMatch = manifestContent.match(/segment_\d+\.ts/);
              if (segmentMatch) {
                const segmentPath = path.join(stream.outputDir, segmentMatch[0]);
                if (fs.existsSync(segmentPath)) {
                  clearInterval(checkInterval);
                  console.log(`HLS first segment ready: ${segmentMatch[0]}`);
                  resolve();
                  return;
                }
              }
            }
          } catch (error) {
            // File exists but can't read it yet, continue waiting
            console.log("File exists but can't read yet, waiting")
          }
        }
      }, 500); // Check every 500ms
    });
  }

  // New method for handling multi-participant FFmpeg process
  private async startFFmpegProcessMultiParticipant(
    stream: HLSStream,
    videoWidth: number,
    videoHeight: number
  ): Promise<void> {
    const outputPath = path.join(stream.outputDir, "stream.m3u8");
    const participantCount = stream.participants.length;

    console.log(`Starting FFmpeg process for ${participantCount} participants`);
    console.log(`Output resolution: ${videoWidth}x${videoHeight}`);

    // Connect all transports and create SDP files
    const sdpFiles: { video: string; audio: string }[] = [];

    for (let i = 0; i < stream.participants.length; i++) {
      const participant = stream.participants[i];

      // Connect transports
      await participant.videoTransport.connect({
        ip: "127.0.0.1",
        port: participant.videoPort,
        rtcpPort: participant.videoPort + 1,
      });

      await participant.audioTransport.connect({
        ip: "127.0.0.1",
        port: participant.audioPort,
        rtcpPort: participant.audioPort + 1,
      });

      console.log(`Participant ${i + 1} transports connected - Video: ${participant.videoPort}, Audio: ${participant.audioPort}`);

      // Create SDP files for this participant
      const videoSdp = this.createVideoSDP(
        participant.videoConsumer.rtpParameters,
        participant.videoPort,
        videoWidth / Math.ceil(Math.sqrt(participantCount)), // Adjust for grid
        videoHeight / Math.ceil(Math.sqrt(participantCount))
      );

      const audioSdp = this.createAudioSDP(
        participant.audioConsumer.rtpParameters,
        participant.audioPort
      );

      const videoSdpPath = path.join(stream.outputDir, `video${i}.sdp`);
      const audioSdpPath = path.join(stream.outputDir, `audio${i}.sdp`);

      fs.writeFileSync(videoSdpPath, videoSdp);
      fs.writeFileSync(audioSdpPath, audioSdp);

      sdpFiles.push({
        video: videoSdpPath,
        audio: audioSdpPath,
      });
    }

    // Wait for connections to establish
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Test RTP reception for all participants
    await this.testMultiParticipantRTP(stream);

    // Build FFmpeg command
    const ffmpegCommand = ffmpeg();

    // Add all inputs
    sdpFiles.forEach((files, index) => {
      ffmpegCommand
        .input(files.video)
        .inputOptions([
          "-protocol_whitelist", "file,rtp,udp",
          "-fflags", "+genpts",
          "-rw_timeout", "30000000",
          "-probesize", "5000000",
          "-analyzeduration", "5000000",
          "-reorder_queue_size", "0",
          "-max_delay", "500000",
          "-f", "sdp",
        ])
        .input(files.audio)
        .inputOptions([
          "-protocol_whitelist", "file,rtp,udp",
          "-fflags", "+genpts",
          "-rw_timeout", "30000000",
          "-probesize", "5000000",
          "-analyzeduration", "5000000",
          "-reorder_queue_size", "0",
          "-max_delay", "500000",
          "-f", "sdp",
        ]);
    });

    // Generate filter complex for video composition and audio mixing
    const { videoFilter, audioFilter, videoMap, audioMap } = this.generateFilterComplex(participantCount);

    ffmpegCommand
      .complexFilter([videoFilter, audioFilter])
      .outputOptions([
        "-y",
        "-map", videoMap,
        "-map", audioMap,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-pix_fmt", "yuv420p",
        "-s", `${videoWidth}x${videoHeight}`,
        "-r", "30",
        "-g", "30",
        "-keyint_min", "30",
        "-sc_threshold", "0",
        "-b:v", "2000k", // Increased bitrate for multiple streams
        "-maxrate", "2500k",
        "-bufsize", "4000k",
        "-b:a", "128k",
        "-ar", "48000",
        "-ac", "2",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "10",
        "-hls_flags", "independent_segments",
        "-hls_delete_threshold", "1",
        "-hls_segment_filename", path.join(stream.outputDir, "segment_%03d.ts"),
        "-hls_start_number_source", "datetime",
        "-avoid_negative_ts", "make_zero",
        "-loglevel", "info",
        "-force_key_frames", "expr:gte(t,n_forced*2)",
        "-flags", "+cgop",
      ])
      .output(outputPath)
      .on("start", (commandLine: string) => {
        console.log("Multi-participant FFmpeg started:");
        console.log(commandLine);

        // Enhanced keyframe requesting - repeat for first few seconds to ensure startup
        const requestKeyframesForAllParticipants = () => {
          stream.participants.forEach((participant, index) => {
            setTimeout(() => {
              this.requestKeyFrame(participant.videoConsumer);
            }, index * 100); // Stagger by 100ms per participant
          });
        };

        // Request keyframes immediately and then repeat every 1 second for 5 seconds
        requestKeyframesForAllParticipants();

        const keyframeInterval = setInterval(() => {
          requestKeyframesForAllParticipants();
        }, 2000);

        // Stop repeated requests after 5 seconds
        setTimeout(() => {
          clearInterval(keyframeInterval);
          console.log("Stopped repeated keyframe requests - FFmpeg should be stable now");
        }, 5000);
      })
      .on("error", (err: Error) => {
        console.error("Multi-participant FFmpeg error:", err.message);
        this.stopHLSStream(stream.roomId);
      })
      .on("end", () => {
        console.log("Multi-participant FFmpeg ended for room:", stream.roomId);
        this.stopHLSStream(stream.roomId);
      })
      .on("stderr", (stderrLine: string) => {
        console.log("FFmpeg:", stderrLine.trim());
      });

    stream.ffmpegProcess = ffmpegCommand;

    // Start FFmpeg
    await new Promise((resolve) => setTimeout(resolve, 5000));
    stream.ffmpegProcess.run();

    await this.waitForFirstSegment(stream);

    // Check output after delay
    setTimeout(() => {
      this.checkHLSOutput(stream);
    }, 20000);
  }

  // Generate filter complex based on participant count
  private generateFilterComplex(participantCount: number): {
    videoFilter: string;
    audioFilter: string;
    videoMap: string;
    audioMap: string;
  } {
    let videoFilter: string;
    let audioFilter: string;

    switch (participantCount) {
      case 1:
        // Single participant - full screen
        videoFilter = "[0:v]scale=1280:720[vout]";
        audioFilter = "[1:a]anull[aout]";
        break;

      case 2:
        // Two participants - side by side
        videoFilter = "[0:v]scale=640:720[v0];[2:v]scale=640:720[v1];[v0][v1]hstack=inputs=2[vout]";
        audioFilter = "[1:a][3:a]amix=inputs=2:duration=longest[aout]";
        break;

      case 3:
        // Three participants - one large on left, two small stacked on right
        videoFilter = "[0:v]scale=853:720[v0];[2:v]scale=427:360[v1];[4:v]scale=427:360[v2];[v1][v2]vstack=inputs=2[vright];[v0][vright]hstack=inputs=2[vout]";
        audioFilter = "[1:a][3:a][5:a]amix=inputs=3:duration=longest[aout]";
        break;

      case 4:
        // Four participants - 2x2 grid
        videoFilter = "[0:v]scale=640:360[v0];[2:v]scale=640:360[v1];[4:v]scale=640:360[v2];[6:v]scale=640:360[v3];[v0][v1]hstack=inputs=2[top];[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[vout]";
        audioFilter = "[1:a][3:a][5:a][7:a]amix=inputs=4:duration=longest[aout]";
        break;

      default:
        throw new Error(`Unsupported participant count: ${participantCount}`);
    }

    return {
      videoFilter,
      audioFilter,
      videoMap: "[vout]",
      audioMap: "[aout]",
    };
  }

  // Test RTP reception for all participants
  private async testMultiParticipantRTP(stream: HLSStream): Promise<void> {
    console.log("Testing RTP reception for all participants...");

    const testPromises = stream.participants.map(async (participant, index) => {
      const videoTest = await this.testRTPReception(participant.videoPort);
      const audioTest = await this.testRTPReception(participant.audioPort);

      console.log(`Participant ${index + 1} - Video RTP: ${videoTest ? "PASS" : "FAIL"}, Audio RTP: ${audioTest ? "PASS" : "FAIL"}`);

      return videoTest && audioTest;
    });

    const results = await Promise.all(testPromises);
    const allPassed = results.every(result => result);

    if (!allPassed) {
      console.warn("Some RTP tests failed, but continuing with FFmpeg startup...");
    } else {
      console.log("All participant RTP tests passed!");
    }
  }

  // Updated cleanup method for multi-participant support
  private cleanup(stream: HLSStream): void {
    if (stream.ffmpegProcess) {
      try {
        stream.ffmpegProcess.kill("SIGTERM");
        setTimeout(() => {
          if (stream.ffmpegProcess) {
            stream.ffmpegProcess.kill("SIGKILL");
          }
        }, 5000);
      } catch (error) {
        console.error("Error killing FFmpeg process:", error);
      }
    }

    // Cleanup all participants
    stream.participants.forEach((participant, index) => {
      try {
        participant.videoConsumer.close();
        participant.audioConsumer.close();
        participant.videoTransport.close();
        participant.audioTransport.close();
        console.log(`Cleaned up participant ${index + 1} resources`);
      } catch (error) {
        console.error(`Error cleaning up participant ${index + 1}:`, error);
      }
    });

    // Clean up directory
    if (fs.existsSync(stream.outputDir)) {
      try {
        fs.rmSync(stream.outputDir, { recursive: true, force: true });
        console.log(`Cleaned up HLS directory: ${stream.outputDir}`);
      } catch (error) {
        console.error("Error cleaning up HLS directory:", error);
      }
    }
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

        if (packetCount >= 3) { // Reduced from 5 to 3 for faster testing
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
            `No RTP packets received on port ${port} after 5 seconds`
          );
          socket.close();
          resolve(false);
        }, 5000); // Reduced timeout for faster testing
      });
    });
  }

  private async createPlainTransport(): Promise<PlainTransport> {
    return await this.router.createPlainTransport({
      listenIp: { ip: "127.0.0.1", announcedIp: undefined },
      rtcpMux: false,
      comedia: false,
      enableSctp: false,
      enableSrtp: false,
    });
  }

  private async requestKeyFrame(consumer: Consumer): Promise<void> {
    try {
      if (consumer.kind === "video") {
        console.log(`Requesting keyframe for video consumer: ${consumer.id}`);
        await consumer.requestKeyFrame();
        console.log(`Keyframe request sent for consumer: ${consumer.id}`);
      }
    } catch (error) {
      console.error(
        `Error requesting keyframe for consumer ${consumer.id}:`,
        error
      );
    }
  }

  private createVideoSDP(
    rtpParameters: RtpParameters,
    port: number,
    videoWidth: number,
    videoHeight: number
  ): string {
    const codec = rtpParameters.codecs[0];
    const encoding = rtpParameters.encodings?.[0];

    if (!encoding) {
      throw new Error("No video encoding found in RTP parameters");
    }

    const sdpLines = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=Mediasoup-HLS-Video",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=video ${port} RTP/AVP ${codec.payloadType}`,
      `a=rtpmap:${codec.payloadType} ${codec.mimeType
        .split("/")[1]
        .toUpperCase()}/${codec.clockRate}`,
      `a=framesize:${codec.payloadType} ${videoWidth}-${videoHeight}`,
      "a=recvonly",
      `a=mid:${rtpParameters.mid || "0"}`,
      `a=ssrc:${encoding.ssrc}`,
      `a=rtcp:${port + 1}`,
    ];

    if (codec.rtcpFeedback && codec.rtcpFeedback.length > 0) {
      codec.rtcpFeedback.forEach((feedback) => {
        sdpLines.push(
          `a=rtcp-fb:${codec.payloadType} ${feedback.type}${feedback.parameter ? " " + feedback.parameter : ""
          }`
        );
      });
    }

    if (codec.parameters) {
      const fmtpParams = Object.entries(codec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(";");
      if (fmtpParams) {
        sdpLines.push(`a=fmtp:${codec.payloadType} ${fmtpParams}`);
      }
    }

    return sdpLines.join("\r\n") + "\r\n";
  }

  private createAudioSDP(rtpParameters: RtpParameters, port: number): string {
    const codec = rtpParameters.codecs[0];
    const encoding = rtpParameters.encodings?.[0];

    if (!encoding) {
      throw new Error("No audio encoding found in RTP parameters");
    }

    const sdpLines = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=Mediasoup-HLS-Audio",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${port} RTP/AVP ${codec.payloadType}`,
      `a=rtpmap:${codec.payloadType} ${codec.mimeType
        .split("/")[1]
        .toUpperCase()}/${codec.clockRate}${codec.channels ? "/" + codec.channels : ""
      }`,
      "a=recvonly",
      `a=mid:${rtpParameters.mid || "0"}`,
      `a=ssrc:${encoding.ssrc}`,
      `a=rtcp:${port + 1}`,
    ];

    if (codec.parameters) {
      const fmtpParams = Object.entries(codec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(";");
      if (fmtpParams) {
        sdpLines.push(`a=fmtp:${codec.payloadType} ${fmtpParams}`);
      }
    }

    return sdpLines.join("\r\n") + "\r\n";
  }

  private checkHLSOutput(stream: HLSStream): void {
    const manifestPath = path.join(stream.outputDir, "stream.m3u8");

    console.log(`\n=== Multi-Participant HLS Output Check for room ${stream.roomId} ===`);
    console.log(`Participants: ${stream.participants.length}`);
    console.log(`Manifest exists: ${fs.existsSync(manifestPath)}`);

    if (fs.existsSync(manifestPath)) {
      const manifestContent = fs.readFileSync(manifestPath, "utf8");
      console.log(`Manifest content:\n${manifestContent}`);
    }

    try {
      const files = fs.readdirSync(stream.outputDir);
      const segmentFiles = files.filter(
        (file) => file.startsWith("segment_") && file.endsWith(".ts")
      );
      console.log(`Segment files found: ${segmentFiles.length}`);
      segmentFiles.forEach((file) => {
        const filePath = path.join(stream.outputDir, file);
        const stats = fs.statSync(filePath);
        console.log(`${file}: ${stats.size} bytes`);
      });
    } catch (error) {
      console.log("Error reading directory:", error);
    }
    console.log("=== End Multi-Participant HLS Output Check ===\n");
  }

  stopHLSStream(roomId: string): void {
    const stream = this.streams.get(roomId);
    if (stream) {
      this.cleanup(stream);
      this.streams.delete(roomId);
      console.log(`Multi-participant HLS stream stopped for room: ${roomId}`);
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