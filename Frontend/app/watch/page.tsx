'use client';

import { useEffect, useRef, useState } from 'react';
import { socketManager } from '@/lib/socket';

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = socketManager.connect();

    // Join as viewer
    socket.emit('join-room', { roomId: 'test-room', isViewer: true });

    // Listen for HLS stream ready
    socket.on('hls-ready', (data) => {
      console.log('HLS ready:', data);
      setHlsUrl(data.hlsUrl);
      setIsLoading(false);
      initializeHLS(data.hlsUrl);
    });

    socket.on('error', (data) => {
      setError(data.message);
      setIsLoading(false);
    });

    return () => {
      socketManager.disconnect();
    };
  }, []);

  const initializeHLS = async (url: string) => {
    if (!videoRef.current) return;

    try {
      // Check if HLS is natively supported
      if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        videoRef.current.src = `http://localhost:8000${url}`;
      } else {
        // Use HLS.js for other browsers
        const Hls = (await import('hls.js')).default;
        
        if (Hls.isSupported()) {
          const hls = new Hls({
            debug: true,
            enableWorker: true,
            lowLatencyMode: true,
          });
          
          hls.loadSource(`http://localhost:8000${url}`);
          hls.attachMedia(videoRef.current);
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS manifest parsed');
            videoRef.current?.play();
          });

          hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS error:', data);
            if (data.fatal) {
              setError('Failed to load HLS stream');
            }
          });
        } else {
          setError('HLS is not supported in this browser');
        }
      }
    } catch (error) {
      console.error('Error initializing HLS:', error);
      setError('Failed to initialize video player');
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Watch Live Stream</h1>
        
        <div className="bg-gray-800 rounded-lg p-4">
          {isLoading && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
                <p>Waiting for stream to start...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center text-red-400">
                <p className="text-xl mb-2">❌ Error</p>
                <p>{error}</p>
              </div>
            </div>
          )}

          {hlsUrl && !error && (
            <div>
              <video
                ref={videoRef}
                controls
                autoPlay
                muted
                playsInline
                className="w-full h-auto bg-black rounded"
                poster="/api/placeholder/800/450"
              />
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                  <span className="text-sm text-gray-300">LIVE</span>
                </div>
                <div className="text-sm text-gray-400">
                  Stream URL: {hlsUrl}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-2">Instructions:</h3>
          <ul className="list-disc list-inside space-y-2 text-gray-300">
            <li>This page shows the live HLS stream from all streamers</li>
            <li>The stream will start automatically when streamers begin broadcasting</li>
            <li>There may be a 5-10 second delay compared to WebRTC streams</li>
            <li>Go to <code className="bg-gray-700 px-2 py-1 rounded">/stream</code> to start streaming</li>
          </ul>
        </div>
      </div>
    </div>
  );
}