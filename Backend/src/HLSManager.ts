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
      comedia: true,
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
    console.log("Testing RTP reception...");

  
    const videoRtpTest = await this.testRTPReception(ffmpegVideoPort);
    const audioRtpTest = await this.testRTPReception(ffmpegAudioPort);

    console.log(`Video RTP test: ${videoRtpTest ? "PASS" : "FAIL"}`);
    console.log(`Audio RTP test: ${audioRtpTest ? "PASS" : "FAIL"}`);

    if (!videoRtpTest || !audioRtpTest) {
      throw new Error(
        "RTP streams not detected - check MediaSoup transport connection"
      );
    }

    // Enhanced SDP generation with better VP8 support
    const videoSdpContent =
      [
        "v=0",
        `o=- 0 0 IN IP4 127.0.0.1`,
        "s=Mediasoup-HLS-Video",
        `c=IN IP4 127.0.0.1`,
        "t=0 0",
        `m=video ${ffmpegVideoPort} RTP/AVP ${videoRtpParameters.codecs[0].payloadType}`,
        `a=rtpmap:${
          videoRtpParameters.codecs[0].payloadType
        } ${videoRtpParameters.codecs[0].mimeType
          .split("/")[1]
          .toUpperCase()}/${videoRtpParameters.codecs[0].clockRate}`,
        // Add framesize attribute for VP8
        `a=framesize:${videoRtpParameters.codecs[0].payloadType} ${videoWidth}-${videoHeight}`,
        // Add explicit video dimensions as custom attribute
        `a=x-dimensions:${videoWidth}x${videoHeight}`,
        ...(videoRtpParameters.codecs[0].parameters &&
        Object.keys(videoRtpParameters.codecs[0].parameters).length > 0
          ? [
              `a=fmtp:${
                videoRtpParameters.codecs[0].payloadType
              } ${Object.entries(videoRtpParameters.codecs[0].parameters)
                .map(([k, v]) => `${k}=${v}`)
                .join(";")}`,
            ]
          : []),
        ...(videoRtpParameters.codecs[0].rtcpFeedback
          ? videoRtpParameters.codecs[0].rtcpFeedback.map(
              (fb: { type: string; parameter?: string }) =>
                `a=rtcp-fb:${videoRtpParameters.codecs[0].payloadType} ${
                  fb.type
                }${fb.parameter ? " " + fb.parameter : ""}`
            )
          : []),
        `a=recvonly`,
        `a=mid:${videoRtpParameters.mid || "0"}`,
        `a=ssrc:${videoRtpParameters.encodings?.[0]?.ssrc || "1"} cname:${
          videoRtpParameters.rtcp?.cname || "video-stream"
        }`,
        `a=rtcp:${ffmpegVideoRtcpPort}`,
      ].join("\r\n") + "\r\n";

    const audioSdpContent =
      [
        "v=0",
        `o=- 0 0 IN IP4 127.0.0.1`,
        "s=Mediasoup-HLS-Audio",
        `c=IN IP4 127.0.0.1`,
        "t=0 0",
        `m=audio ${ffmpegAudioPort} RTP/AVP ${audioRtpParameters.codecs[0].payloadType}`,
        `a=rtpmap:${
          audioRtpParameters.codecs[0].payloadType
        } ${audioRtpParameters.codecs[0].mimeType
          .split("/")[1]
          .toUpperCase()}/${audioRtpParameters.codecs[0].clockRate}/${
          audioRtpParameters.codecs[0].channels || 2
        }`,
        ...(audioRtpParameters.codecs[0].parameters &&
        Object.keys(audioRtpParameters.codecs[0].parameters).length > 0
          ? [
              `a=fmtp:${
                audioRtpParameters.codecs[0].payloadType
              } ${Object.entries(audioRtpParameters.codecs[0].parameters)
                .map(([k, v]) => `${k}=${v}`)
                .join(";")}`,
            ]
          : []),
        `a=recvonly`,
        `a=mid:${audioRtpParameters.mid || "0"}`,
        `a=ssrc:${audioRtpParameters.encodings?.[0]?.ssrc || "2"} cname:${
          audioRtpParameters.rtcp?.cname || "audio-stream"
        }`,
        `a=rtcp:${ffmpegAudioRtcpPort}`,
      ].join("\r\n") + "\r\n";

    const videoSdpFilePath = path.join(stream.outputDir, "video.sdp");
    const audioSdpFilePath = path.join(stream.outputDir, "audio.sdp");

    fs.writeFileSync(videoSdpFilePath, videoSdpContent);
    fs.writeFileSync(audioSdpFilePath, audioSdpContent);

    console.log(`SDP file generated: ${videoSdpFilePath}`);
    console.log(`SDP file generated: ${audioSdpFilePath}`);

    // Only connect transports if they haven't been connected yet
    try {
      // Check if transport is already connected by checking its state
      if (stream.videoTransport && !(stream.videoTransport as any)._connected) {
        await stream.videoTransport.connect({
          ip: "127.0.0.1",
          port: ffmpegVideoPort,
          rtcpPort: ffmpegVideoRtcpPort,
        });
        (stream.videoTransport as any)._connected = true;
        console.log(
          `Mediasoup video transport sending RTP to FFmpeg at 127.0.0.1:${ffmpegVideoPort} (RTCP: ${ffmpegVideoRtcpPort})`
        );
      }

      if (stream.audioTransport && !(stream.audioTransport as any)._connected) {
        await stream.audioTransport.connect({
          ip: "127.0.0.1",
          port: ffmpegAudioPort,
          rtcpPort: ffmpegAudioRtcpPort,
        });
        (stream.audioTransport as any)._connected = true;
        console.log(
          `Mediasoup audio transport sending RTP to FFmpeg at 127.0.0.1:${ffmpegAudioPort} (RTCP: ${ffmpegAudioRtcpPort})`
        );
      }
    } catch (error) {
      console.error("Transport connection error:", error);
      // If transport connection fails, the transports are likely already connected
    }

    // Wait for RTP streams to be established
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Simplified FFmpeg command - try basic approach first
    stream.ffmpegProcess = ffmpeg()
      .input(videoSdpFilePath)
      .inputOptions([
        "-protocol_whitelist",
        "file,rtp,udp",
        "-fflags",
        "+genpts+discardcorrupt",
        "-probesize",
        "5000000",
        "-analyzeduration",
        "5000000",
        "-re",
      ])
      .input(audioSdpFilePath)
      .inputOptions([
        "-protocol_whitelist",
        "file,rtp,udp",
        "-fflags",
        "+genpts+discardcorrupt",
        "-probesize",
        "5000000",
        "-analyzeduration",
        "5000000",
      ])
      .outputOptions([
        "-y",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        // Force video size explicitly
        "-s",
        `${videoWidth}x${videoHeight}`,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "keyint=30:min-keyint=30:no-scenecut",
        "-b:v",
        "1000k",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_list_size",
        "5",
        "-hls_flags",
        "delete_segments+independent_segments",
        "-hls_segment_filename",
        path.join(stream.outputDir, "segment_%03d.ts"),
        "-avoid_negative_ts",
        "make_zero",
      ])
      .output(outputPath)
      .on("start", (commandLine: string) => {
        console.log("FFmpeg started:", commandLine);
      })
      .on("error", (err: Error) => {
        console.error("FFmpeg error:", err.message);
        // Don't restart automatically to avoid the transport connection error
        console.log("FFmpeg failed - stopping HLS stream");
        this.stopHLSStream(stream.roomId);
      })
      .on("end", () => {
        console.log("FFmpeg ended for room:", stream.roomId);
      })
      .on("stderr", (stderrLine: string) => {
        if (stderrLine.includes("frame=") || stderrLine.includes("time=")) {
          // Progress info - log occasionally
          if (Math.random() < 0.1)
            console.log("FFmpeg progress:", stderrLine.trim());
        } else if (
          stderrLine.includes("Error") ||
          stderrLine.includes("failed")
        ) {
          console.error("FFmpeg stderr:", stderrLine);
        }
      });

    stream.ffmpegProcess.run();
  }

  // Remove the restart method since we're not using auto-restart anymore

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
