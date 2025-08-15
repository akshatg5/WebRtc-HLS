"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Loader2, Users, Video, Mic, RefreshCw } from "lucide-react";
import Hls from "hls.js";

interface Producer {
  producerId: string;
  kind: "audio" | "video";
  peerId: string;
  appData?: any;
}

interface Room {
  id: string;
  participants: number;
  producers: Producer[];
}

export default function WatchPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [isWatching, setIsWatching] = useState(false);
  const [streamUrl, setStreamUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Fetch active rooms
  const fetchRooms = async () => {
    try {
      setRoomsLoading(true);
      const response = await fetch("http://localhost:8000/api/rooms");
      const data = await response.json();
      setRooms(data.rooms || []);
    } catch (error) {
      console.error("Error fetching rooms:", error);
    } finally {
      setRoomsLoading(false);
    }
  };

  // Auto-refresh rooms every 5 seconds
  useEffect(() => {
    fetchRooms();
    const interval = setInterval(fetchRooms, 5000);
    return () => clearInterval(interval);
  }, []);

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

  const startHLSStream = async (roomId: string) => {
    setLoading(true);
    setError("");
    setSelectedRoomId(roomId);

    try {
      const roomStatus = await checkRoomStatus(roomId);
      if (!roomStatus?.roomExists || roomStatus.participants === 0) {
        setError("Room not found or no active participants");
        setLoading(false);
        return;
      }

      // Start HLS stream
      const response = await fetch(
        `http://localhost:8000/api/hls/start/${roomId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      const data = await response.json();

      if (data.success) {
        setStreamUrl(`http://localhost:8000${data.streamUrl}`);
        setIsWatching(true);
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
      await fetch(`http://localhost:8000/api/hls/stop/${selectedRoomId}`, {
        method: "DELETE",
      });

      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.src = "";
      }

      setIsWatching(false);
      setStreamUrl("");
      setSelectedRoomId("");
    } catch (error) {
      console.error("Error stopping stream:", error);
    }
  };

  useEffect(() => {
    if (streamUrl && videoRef.current) {
      // Test if manifest is accessible
      fetch(streamUrl)
        .then((response) => {
          console.log("Manifest response status:", response.status);
          return response.text();
        })
        .then((text) => {
          console.log("Manifest content:", text);
        })
        .catch((error) => {
          console.error("Failed to fetch manifest:", error);
        });
        
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
                console.error("fatal network error encountered, try to recover");
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.error("fatal media error encountered, try to recover");
                hls.recoverMediaError();
                break;
              default:
                hls.destroy();
                break;
            }
          }
        });
      } else if (
        videoRef.current.canPlayType("application/vnd.apple.mpegurl")
      ) {
        videoRef.current.src = streamUrl;
        videoRef.current.load();
        videoRef.current.play();
      } else {
        setError("Your browser does not support HLS video.");
      }
    }
  }, [streamUrl]);

  const getStreamInfo = (room: Room) => {
    const videoProducers = room.producers.filter(p => p.kind === "video").length;
    const audioProducers = room.producers.filter(p => p.kind === "audio").length;
    const hasStreams = videoProducers > 0 && audioProducers > 0;
    
    return { videoProducers, audioProducers, hasStreams };
  };

  const activeRooms = rooms.filter(room => room.participants > 0);

  return (
    <div className="min-h-[calc(100vh-80px)] p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Watch Live Streams</h1>
            <p className="text-gray-600 mt-1">Select an active room to watch the live stream</p>
          </div>
          <Button onClick={fetchRooms} variant="outline" size="sm">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>

        {/* Manual Room Input */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Enter Room ID</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input
                placeholder="Enter Room ID"
                value={selectedRoomId}
                onChange={(e) => setSelectedRoomId(e.target.value)}
                disabled={isWatching || loading}
                className="flex-1"
              />
              {!isWatching ? (
                <Button
                  onClick={() => startHLSStream(selectedRoomId)}
                  disabled={!selectedRoomId.trim() || loading}
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
          </CardContent>
        </Card>

        {/* Active Rooms Grid */}
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-4">Active Rooms ({activeRooms.length})</h2>
          
          {roomsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-gray-500" />
              <span className="ml-2 text-gray-500">Loading rooms...</span>
            </div>
          ) : activeRooms.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <Users className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No Active Rooms</h3>
                <p className="text-gray-500">No rooms with active participants found. Create a room to get started.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeRooms.map((room) => {
                const { videoProducers, audioProducers, hasStreams } = getStreamInfo(room);
                const isCurrentRoom = selectedRoomId === room.id && isWatching;
                
                return (
                  <Card 
                    key={room.id} 
                    className={`cursor-pointer transition-all hover:shadow-lg border-2 ${
                      isCurrentRoom ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => !isWatching && hasStreams && startHLSStream(room.id)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg font-medium">Room {room.id}</CardTitle>
                        {isCurrentRoom && <Badge variant="default">Watching</Badge>}
                        {!hasStreams && <Badge variant="secondary">No Streams</Badge>}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        <div className="flex items-center text-sm text-gray-600">
                          <Users className="w-4 h-4 mr-2" />
                          <span>{room.participants} participant{room.participants !== 1 ? 's' : ''}</span>
                        </div>
                        
                        <div className="flex items-center gap-4 text-sm">
                          <div className="flex items-center text-gray-600">
                            <Video className="w-4 h-4 mr-1" />
                            <span>{videoProducers} video</span>
                          </div>
                          <div className="flex items-center text-gray-600">
                            <Mic className="w-4 h-4 mr-1" />
                            <span>{audioProducers} audio</span>
                          </div>
                        </div>

                        <Button 
                          className="w-full mt-3" 
                          disabled={!hasStreams || isWatching || loading}
                          variant={hasStreams ? "default" : "secondary"}
                        >
                          {isCurrentRoom ? (
                            <>
                              <Square className="w-4 h-4 mr-2" />
                              Currently Watching
                            </>
                          ) : hasStreams ? (
                            <>
                              <Play className="w-4 h-4 mr-2" />
                              Watch Stream
                            </>
                          ) : (
                            "No Streams Available"
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <Card className="mb-6 border-red-200 bg-red-50">
            <CardContent className="py-4">
              <div className="text-red-600 text-sm">{error}</div>
            </CardContent>
          </Card>
        )}

        {/* Video Player */}
        {isWatching && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Live Stream - Room {selectedRoomId}
                <Badge variant="destructive">LIVE</Badge>
              </CardTitle>
            </CardHeader>
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