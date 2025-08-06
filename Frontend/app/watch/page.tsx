"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Loader2 } from "lucide-react";
import Hls from "hls.js";

export default function WatchPage() {
  const [roomId, setRoomId] = useState("");
  const [isWatching, setIsWatching] = useState(false);
  const [streamUrl, setStreamUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [roomProducers, setRoomProducers] = useState<any[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);

  const checkRoomStatus = async (roomId: string) => {
    try {
      const response = await fetch(
        `http://localhost:8000/api/rooms/${roomId}/join`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Error checking room status:", error);
      return null;
    }
  };

  const getRoomProducers = async (roomId: string) => {
    try {
      // Fetch producers for the specific room directly
      const response = await fetch(`http://localhost:8000/api/rooms/${roomId}/producers`);
      const data = await response.json();
      return data.producers || []; // Ensure it returns the array of producers
    } catch (error) {
      console.error("Error getting room producers:", error);
      return [];
    }
  };

  const startHLSStream = async () => {
    setLoading(true);
    setError("");

    try {
      const roomStatus = await checkRoomStatus(roomId);
      if (!roomStatus?.roomExists || roomStatus.participants === 0) {
        setError("Room not found or no active participants");
        setLoading(false);
        return;
      }

      const producers = await getRoomProducers(roomId);
      setRoomProducers(producers);

      if (producers.length === 0) {
        setError("No active streams in this room");
        setLoading(false);
        return;
      }

      const videoProducer = producers.find((p: any) => p.kind === "video");
      const audioProducer = producers.find((p: any) => p.kind === "audio");

      if (!videoProducer || !audioProducer) {
        setError("Room must have both video and audio streams");
        setLoading(false);
        return;
      }

      // Extract width and height from videoProducer's appData
      // Assuming appData structure from RoomPage.tsx (e.g., appData: { width, height })
      const videoWidth = videoProducer.appData?.width;
      const videoHeight = videoProducer.appData?.height;

      if (!videoWidth || !videoHeight) {
        setError("Could not retrieve video dimensions for HLS streaming.");
        setLoading(false);
        return;
      }

      // Start HLS stream
      const response = await fetch(
        `http://localhost:8000/api/hls/start/${roomId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoProducerId: videoProducer.producerId,
            audioProducerId: audioProducer.producerId,
            videoWidth: videoWidth,   // Pass width
            videoHeight: videoHeight, // Pass height
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        setStreamUrl(`http://localhost:8000${data.streamUrl}`);
        setIsWatching(true);

        // REMOVE this setTimeout block. HLS.js will handle loading
        // setTimeout(() => {
        //   if (videoRef.current) {
        //     videoRef.current.src = `http://localhost:8000${data.streamUrl}`;
        //     videoRef.current.load();
        //   }
        // }, 5000);

      } else {
        setError(data.error || "Failed to start stream");
      }
    } catch (error) {
      setError("Failed to start watching");
      console.error("Error starting HLS stream:", error);
    }

    setLoading(false);
  };

  const stopWatching = async () => {
    try {
      await fetch(`http://localhost:8000/api/hls/stop/${roomId}`, {
        method: "DELETE",
      });

      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.src = "";
      }

      setIsWatching(false);
      setStreamUrl("");
      setRoomProducers([]);
    } catch (error) {
      console.error("Error stopping stream:", error);
    }
  };

  useEffect(() => {
    if (streamUrl && videoRef.current) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(streamUrl);
        hls.attachMedia(videoRef.current);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          videoRef.current?.play();
        });
        hls.on(Hls.Events.ERROR, function (event, data) {
          console.error("HLS.js error:", data);
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                // try to recover network error
                console.error(
                  "fatal network error encountered, try to recover"
                );
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.error("fatal media error encountered, try to recover");
                hls.recoverMediaError();
                break;
              default:
                // cannot recover
                hls.destroy();
                break;
            }
          }
        });
      } else if (
        videoRef.current.canPlayType("application/vnd.apple.mpegurl")
      ) {
        // Native HLS support (Safari)
        videoRef.current.src = streamUrl;
        videoRef.current.load();
        videoRef.current.play();
      } else {
        setError("Your browser does not support HLS video.");
      }
    }
  }, [streamUrl]);

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Watch Live Stream
              {isWatching && <Badge variant="secondary">Live</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="Enter Room ID"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                disabled={isWatching || loading}
              />
              {!isWatching ? (
                <Button
                  onClick={startHLSStream}
                  disabled={!roomId.trim() || loading}
                  className="min-w-[120px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 mr-2" />
                      Watch
                    </>
                  )}
                </Button>
              ) : (
                <Button onClick={stopWatching} variant="destructive">
                  <Square className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              )}
            </div>

            {error && (
              <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                {error}
              </div>
            )}

            {roomProducers.length > 0 && (
              <div className="text-sm text-gray-600">
                Active streams: {roomProducers.map((p) => p.kind).join(", ")}
              </div>
            )}
          </CardContent>
        </Card>

        {isWatching && (
          <Card>
            <CardContent className="p-6">
              <div className="aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  controls
                  autoPlay
                  muted
                  className="w-full h-full"
                  onError={(e) => {
                    console.error("Video error:", e);
                    setError("Failed to load video stream");
                  }}
                >
                  Your browser does not support the video tag.
                </video>
              </div>

              {streamUrl && (
                <div className="mt-4 text-sm text-gray-500">
                  Stream URL: {streamUrl}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
