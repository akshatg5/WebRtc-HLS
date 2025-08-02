'use client';

import { useEffect, useRef, useState } from 'react';
import { socketManager } from '@/lib/socket';
import { WebRTCManager } from '@/lib/webrtc';

export default function StreamPage() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [webrtcManager, setWebrtcManager] = useState<WebRTCManager | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const socket = socketManager.connect();
    const manager = new WebRTCManager(socket);
    setWebrtcManager(manager);

    // Listen for new producers (other streamers)
    socket.on('new-producer', async (data) => {
      console.log('New producer:', data);
      if (manager && data.userId !== socket.id) {
        try {
          await manager.createRecvTransport();
          const consumer = await manager.consume(data.producerId);
          
          if (remoteVideoRef.current && consumer.track) {
            const remoteStream = new MediaStream([consumer.track]);
            remoteVideoRef.current.srcObject = remoteStream;
          }
        } catch (error) {
          console.error('Error consuming:', error);
        }
      }
    });

    return () => {
      socketManager.disconnect();
    };
  }, []);

  const startStreaming = async () => {
    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: true
      });

      setLocalStream(stream);

      // Display local video
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Initialize WebRTC
      if (webrtcManager) {
        await webrtcManager.initialize();
        await webrtcManager.createSendTransport();
        await webrtcManager.produce(stream);
      }

      setIsStreaming(true);
    } catch (error) {
      console.error('Error starting stream:', error);
    }
  };

  const stopStreaming = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    setIsStreaming(false);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Stream Page</h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Local Video */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-xl font-semibold mb-4">Your Stream</h2>
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-64 bg-black rounded"
            />
            <div className="mt-4 space-x-4">
              {!isStreaming ? (
                <button
                  onClick={startStreaming}
                  className="bg-green-500 hover:bg-green-600 px-6 py-2 rounded-lg font-medium"
                >
                  Start Stream
                </button>
              ) : (
                <button
                  onClick={stopStreaming}
                  className="bg-red-500 hover:bg-red-600 px-6 py-2 rounded-lg font-medium"
                >
                  Stop Stream
                </button>
              )}
            </div>
          </div>

          {/* Remote Video */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-xl font-semibold mb-4">Other Streamers</h2>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-64 bg-black rounded"
            />
          </div>
        </div>

        <div className="mt-8 bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-2">Instructions:</h3>
          <ul className="list-disc list-inside space-y-2 text-gray-300">
            <li>Click "Start Stream" to begin broadcasting</li>
            <li>Open another tab in incognito mode to test with multiple streamers</li>
            <li>Other streamers will appear in the "Other Streamers" section</li>
            <li>Viewers can watch at <code className="bg-gray-700 px-2 py-1 rounded">/watch</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}