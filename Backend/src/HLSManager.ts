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

  async startHLSStream(
    roomId: string,
    videoProducerId: string,
    audioProducerId: string,
    videoWidth: number, // Added videoWidth
    videoHeight: number // Added videoHeight
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
        videoWidth, // Pass videoWidth
        videoHeight // Pass videoHeight
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
    videoWidth: number, // Added for SDP
    videoHeight: number  // Added for SDP
  ): Promise<void> {
    const ffmpegVideoPort = 20000;
    const ffmpegAudioPort = 20002;
    const ffmpegVideoRtcpPort = ffmpegVideoPort + 1;
    const ffmpegAudioRtcpPort = ffmpegAudioPort + 1;

    const outputPath = path.join(stream.outputDir, "stream.m3u8");

    if (!stream.videoConsumer || !stream.audioConsumer) {
      throw new Error("Consumers are not initialized for FFmpeg setup.");
    }

    // --- Generate SDP content for FFmpeg to understand the incoming RTP streams ---
    // Video SDP
    const videoSdpContent = [
      "v=0",
      `o=- 0 0 IN IP4 127.0.0.1`,
      "s=Mediasoup-HLS-Video",
      `c=IN IP4 127.0.0.1`,
      "t=0 0",
      `m=video ${ffmpegVideoPort} RTP/AVP ${videoRtpParameters.codecs[0].payloadType}`,
      `a=rtpmap:${videoRtpParameters.codecs[0].payloadType} ${videoRtpParameters.codecs[0].mimeType.split('/')[1].toUpperCase()}/${videoRtpParameters.codecs[0].clockRate}`,
      // Crucial: Add framesize for video dimensions
      `a=framesize:${videoRtpParameters.codecs[0].payloadType} ${videoWidth}-${videoHeight}`,
      ...(videoRtpParameters.codecs[0].parameters && Object.keys(videoRtpParameters.codecs[0].parameters).length > 0
        ? [`a=fmtp:${videoRtpParameters.codecs[0].payloadType} ${Object.entries(videoRtpParameters.codecs[0].parameters).map(([k, v]) => `${k}=${v}`).join(';')}`]
        : []
      ),
      ...(videoRtpParameters.codecs[0].rtcpFeedback
        ? videoRtpParameters.codecs[0].rtcpFeedback.map((fb: { type: string; parameter?: string }) => `a=rtcp-fb:${videoRtpParameters.codecs[0].payloadType} ${fb.type}${fb.parameter ? ' ' + fb.parameter : ''}`)
        : []
      ),
      `a=recvonly`,
      `a=mid:${videoRtpParameters.mid || 'video'}`,
      // Safely access encodings and rtcp parameters with fallbacks
      `a=ssrc:${videoRtpParameters.encodings?.[0]?.ssrc || '1'} cname:${videoRtpParameters.rtcp?.cname || 'video-stream'}`,
      `a=rtcp:${ffmpegVideoRtcpPort}`,
    ].join('\r\n') + '\r\n';

    // Audio SDP
    const audioSdpContent = [
      "v=0",
      `o=- 0 0 IN IP4 127.0.0.1`,
      "s=Mediasoup-HLS-Audio",
      `c=IN IP4 127.0.0.1`,
      "t=0 0",
      `m=audio ${ffmpegAudioPort} RTP/AVP ${audioRtpParameters.codecs[0].payloadType}`,
      `a=rtpmap:${audioRtpParameters.codecs[0].payloadType} ${audioRtpParameters.codecs[0].mimeType.split('/')[1].toUpperCase()}/${audioRtpParameters.codecs[0].clockRate}/${audioRtpParameters.codecs[0].channels}`,
      ...(audioRtpParameters.codecs[0].parameters && Object.keys(audioRtpParameters.codecs[0].parameters).length > 0
        ? [`a=fmtp:${audioRtpParameters.codecs[0].payloadType} ${Object.entries(audioRtpParameters.codecs[0].parameters).map(([k, v]) => `${k}=${v}`).join(';')}`]
        : []
      ),
      `a=recvonly`,
      `a=mid:${audioRtpParameters.mid || 'audio'}`,
      // Safely access encodings and rtcp parameters with fallbacks
      `a=ssrc:${audioRtpParameters.encodings?.[0]?.ssrc || '2'} cname:${audioRtpParameters.rtcp?.cname || 'audio-stream'}`,
      `a=rtcp:${ffmpegAudioRtcpPort}`,
    ].join('\r\n') + '\r\n';

    const videoSdpFilePath = path.join(stream.outputDir, 'video.sdp');
    const audioSdpFilePath = path.join(stream.outputDir, 'audio.sdp');

    fs.writeFileSync(videoSdpFilePath, videoSdpContent);
    fs.writeFileSync(audioSdpFilePath, audioSdpContent);

    console.log(`SDP file generated: ${videoSdpFilePath}`);
    console.log(`SDP file generated: ${audioSdpFilePath}`);

    // --- Connect Mediasoup PlainTransports to SEND RTP to FFmpeg's listening ports ---
    await stream.videoTransport!.connect({
      ip: '127.0.0.1',
      port: ffmpegVideoPort,
      rtcpPort: ffmpegVideoRtcpPort
    });
    console.log(
      `Mediasoup video transport sending RTP to FFmpeg at 127.0.0.1:${ffmpegVideoPort} (RTCP: ${ffmpegVideoRtcpPort})`
    );

    await stream.audioTransport!.connect({
      ip: '127.0.0.1',
      port: ffmpegAudioPort,
      rtcpPort: ffmpegAudioRtcpPort
    });
    console.log(
      `Mediasoup audio transport sending RTP to FFmpeg at 127.0.0.1:${ffmpegAudioPort} (RTCP: ${ffmpegAudioRtcpPort})`
    );

    // --- FFmpeg Command Setup ---
    stream.ffmpegProcess = ffmpeg()
      .input(videoSdpFilePath)
      .inputOptions([
        "-protocol_whitelist", "file,rtp,udp",
        "-fflags", "+genpts",
        "-re",
        "-probesize", "5000000", // Increased probesize
        "-analyzeduration", "5000000", // Increased analyzeduration
      ])
      .input(audioSdpFilePath)
      .inputOptions([
        "-protocol_whitelist", "file,rtp,udp",
        "-fflags", "+genpts",
        "-probesize", "5000000", // Increased probesize
        "-analyzeduration", "5000000", // Increased analyzeduration
      ])
      .outputOptions([
        "-map", "0:v:0", // Explicitly map video from the first input (video.sdp)
        "-map", "1:a:0", // Explicitly map audio from the second input (audio.sdp)
        "-c:v", "libx264",
        "-c:a", "aac",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-x264-params", "keyint=30:min-keyint=30",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments+independent_segments",
        "-hls_segment_filename", path.join(stream.outputDir, "segment%03d.ts"),
        "-hls_start_number_source", "datetime",
      ])
      .output(outputPath)
      .on("start", (commandLine: string) => {
        console.log("FFmpeg started:", commandLine);
      })
      .on("error", (err: Error) => { // Fixed: Removed stdout, stderr from arguments
        console.error("FFmpeg error:", err.message);
        if ((err as any).stdout) {
            console.error("FFmpeg stdout:", (err as any).stdout);
        }
        if ((err as any).stderr) {
            console.error("FFmpeg stderr:", (err as any).stderr);
        }
        this.stopHLSStream(stream.roomId);
      })
      .on("end", () => {
        console.log("FFmpeg ended for room:", stream.roomId);
        this.stopHLSStream(stream.roomId);
      })
      .on("stderr", (stderrLine: string) => {
        if (stderrLine.trim().length > 0 && !stderrLine.includes("version") && !stderrLine.includes("built with")) {
            console.log("FFmpeg stderr:", stderrLine);
        }
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
      stream.ffmpegProcess.kill("SIGTERM");
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
      fs.rmSync(stream.outputDir, { recursive: true, force: true });
      console.log(`Cleaned up HLS directory: ${stream.outputDir}`);
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