"use client"

import { useEffect, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { io, type Socket } from "socket.io-client"
import { Device } from "mediasoup-client"
import { Video, Mic, PhoneOff, Copy, User, AlertTriangle, MicOff, VideoOff } from "lucide-react"

interface Peer {
  id: string
  videoStream?: MediaStream
  audioStream?: MediaStream
}

export default function RoomPage() {
  const params = useParams()
  const router = useRouter()
  const roomId = params?.roomId as string

  const [isConnected, setIsConnected] = useState(false)
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map())
  const [isVideoOn, setIsVideoOn] = useState(false)
  const [isAudioOn, setIsAudioOn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const socketRef = useRef<Socket | null>(null)
  const deviceRef = useRef<Device | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const producerTransportRef = useRef<any>(null)
  const consumerTransportRef = useRef<any>(null)
  const producersRef = useRef<Map<string, any>>(new Map())
  const consumersRef = useRef<Map<string, any>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!roomId) return
    initializeConnection()
    return () => {
      cleanup()
    }
  }, [roomId])

  const initializeConnection = async () => {
    try {
      setError(null)
      // Initialize socket connection
      socketRef.current = io(process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000")
      setupSocketListeners()

      // Get RTP capabilities and create device
      const rtpCapabilities = await new Promise((resolve) => {
        socketRef.current?.emit("get-rtp-capabilities", resolve)
      })

      if ((rtpCapabilities as any).error) {
        throw new Error((rtpCapabilities as any).error)
      }

      // Create mediasoup device
      deviceRef.current = new Device()
      await deviceRef.current.load({
        routerRtpCapabilities: (rtpCapabilities as any).rtpCapabilities,
      })

      // Create transports
      await createProducerTransport()
      await createConsumerTransport()

      // Join room
      socketRef.current?.emit("join-room", { roomId })
      setIsConnected(true)
    } catch (error) {
      console.error("Failed to initialize connection:", error)
      setError("Failed to connect to the room. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  const setupSocketListeners = () => {
    if (!socketRef.current) return

    socketRef.current.on("connect", () => {
      console.log("Socket connected")
      setIsConnected(true)
    })

    socketRef.current.on("disconnect", () => {
      console.log("Socket disconnected")
      setIsConnected(false)
    })

    socketRef.current.on("peer-joined", ({ peerId }) => {
      console.log("Peer joined:", peerId)
      setPeers((prev) => new Map(prev.set(peerId, { id: peerId })))
    })

    socketRef.current.on("peer-left", ({ peerId }) => {
      console.log("Peer left:", peerId)
      // Clean up consumers for this peer first
      const consumersToClose: string[] = []
      for (const [consumerId, consumer] of consumersRef.current.entries()) {
        if (consumer.appData?.peerId === peerId) {
          consumer.close()
          consumersToClose.push(consumerId)
        }
      }
      // Remove closed consumers from map
      consumersToClose.forEach((id) => consumersRef.current.delete(id))

      // Remove peer from state
      setPeers((prev) => {
        const newPeers = new Map(prev)
        newPeers.delete(peerId)
        return newPeers
      })
    })

    socketRef.current.on("existing-peers", ({ peers }) => {
      console.log("Existing peers:", peers)
      setPeers((prev) => {
        const newPeers = new Map(prev)
        peers.forEach((peerId: string) => {
          newPeers.set(peerId, { id: peerId })
        })
        return newPeers
      })
    })

    socketRef.current.on("new-producer", ({ producerId, peerId, kind }) => {
      console.log("New producer event received:", { producerId, peerId, kind })
      // Small delay to ensure transports are ready
      setTimeout(() => {
        consume(producerId, peerId, kind)
      }, 100)
    })

    socketRef.current.on("error", ({ message }) => {
      console.error("Socket error:", message)
      setError(message)
    })
  }

  const createProducerTransport = async () => {
    if (!socketRef.current || !deviceRef.current) return

    const transportParams = await new Promise((resolve) => {
      socketRef.current?.emit("create-transport", { direction: "send" }, resolve)
    })

    if ((transportParams as any).error) {
      throw new Error((transportParams as any).error)
    }

    producerTransportRef.current = deviceRef.current.createSendTransport((transportParams as any).params)

    producerTransportRef.current.on("connect", async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await new Promise((resolve) => {
          socketRef.current?.emit(
            "connect-transport",
            {
              transportId: producerTransportRef.current.id,
              dtlsParameters,
            },
            resolve,
          )
        })
        callback()
      } catch (error) {
        errback(error)
      }
    })

    producerTransportRef.current.on(
      "produce",
      async ({ kind, rtpParameters, appData }: any, callback: any, errback: any) => {
        try {
          const result = await new Promise((resolve) => {
            socketRef.current?.emit(
              "produce",
              {
                transportId: producerTransportRef.current.id,
                kind,
                rtpParameters,
                appData,
              },
              resolve,
            )
          })

          if ((result as any).error) {
            throw new Error((result as any).error)
          }
          callback({ id: (result as any).id })
        } catch (error) {
          errback(error)
        }
      },
    )
  }

  const createConsumerTransport = async () => {
    if (!socketRef.current || !deviceRef.current) return

    const transportParams = await new Promise((resolve) => {
      socketRef.current?.emit("create-transport", { direction: "recv" }, resolve)
    })

    if ((transportParams as any).error) {
      throw new Error((transportParams as any).error)
    }

    consumerTransportRef.current = deviceRef.current.createRecvTransport((transportParams as any).params)

    consumerTransportRef.current.on("connect", async ({ dtlsParameters }: any, callback: any, errback: any) => {
      try {
        await new Promise((resolve) => {
          socketRef.current?.emit(
            "connect-transport",
            {
              transportId: consumerTransportRef.current.id,
              dtlsParameters,
            },
            resolve,
          )
        })
        callback()
      } catch (error) {
        errback(error)
      }
    })
  }

  const startVideo = async () => {
    try {
      console.log("Starting video...")
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      })
      const videoTrack = stream.getVideoTracks()[0]
      console.log("Got video track:", videoTrack.id)

      // If we already have a stream, add the new track
      if (localStreamRef.current) {
        localStreamRef.current.addTrack(videoTrack)
      } else {
        localStreamRef.current = stream
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current
      }

      console.log("About to produce video track...")
      const producer = await producerTransportRef.current.produce({
        track: videoTrack,
        encodings: [{ maxBitrate: 500000 }],
        codecOptions: { videoGoogleStartBitrate: 1000 },
      })
      console.log("Video producer created:", producer.id)
      producersRef.current.set("video", producer)
      setIsVideoOn(true)
    } catch (error) {
      console.error("Error starting video:", error)
      setError("Failed to start video. Please check your camera permissions.")
    }
  }

  const startAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      const audioTrack = stream.getAudioTracks()[0]

      // Add audio track to existing stream or create new one
      if (localStreamRef.current) {
        localStreamRef.current.addTrack(audioTrack)
      } else {
        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current
        }
      }

      const producer = await producerTransportRef.current.produce({
        track: audioTrack,
      })
      producersRef.current.set("audio", producer)
      setIsAudioOn(true)
    } catch (error) {
      console.error("Error starting audio:", error)
      setError("Failed to start audio. Please check your microphone permissions.")
    }
  }

  const stopVideo = () => {
    const producer = producersRef.current.get("video")
    if (producer) {
      producer.close()
      producersRef.current.delete("video")
    }
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.stop()
        localStreamRef.current?.removeTrack(track)
      })
    }
    // If no audio tracks remain, clear the video element
    if (localStreamRef.current && localStreamRef.current.getTracks().length === 0) {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null
      }
      localStreamRef.current = null
    }
    setIsVideoOn(false)
  }

  const stopAudio = () => {
    const producer = producersRef.current.get("audio")
    if (producer) {
      producer.close()
      producersRef.current.delete("audio")
    }
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.stop()
        localStreamRef.current?.removeTrack(track)
      })
    }
    setIsAudioOn(false)
  }

  const consume = async (producerId: string, peerId: string, kind: string) => {
    try {
      if (!deviceRef.current || !consumerTransportRef.current) {
        console.error("Device or transport not ready")
        return
      }

      console.log(`Attempting to consume ${kind} from peer ${peerId}, producer ${producerId}`)

      const consumerParams = await new Promise((resolve) => {
        socketRef.current?.emit(
          "consume",
          {
            transportId: consumerTransportRef.current.id,
            producerId,
            rtpCapabilities: deviceRef.current?.rtpCapabilities,
          },
          resolve,
        )
      })

      if ((consumerParams as any).error) {
        console.error("Error getting consumer params:", (consumerParams as any).error)
        return
      }

      const consumer = await consumerTransportRef.current.consume({
        ...(consumerParams as any).params,
        appData: { peerId, kind },
      })
      consumersRef.current.set(consumer.id, consumer)

      // Resume consumer
      const resumeResult = await new Promise((resolve) => {
        socketRef.current?.emit("resume-consumer", { consumerId: consumer.id }, resolve)
      })

      if ((resumeResult as any).error) {
        console.error("Error resuming consumer:", (resumeResult as any).error)
        return
      }
      console.log(`Consumer resumed successfully: ${consumer.id}`)

      // Handle the track
      consumer.on("trackended", () => {
        console.log("Consumer track ended:", consumer.id)
      })
      consumer.on("transportclose", () => {
        console.log("Consumer transport closed:", consumer.id)
      })

      // Update peer with the new track
      setPeers((prev) => {
        const newPeers = new Map(prev)
        const oldPeer = newPeers.get(peerId) || { id: peerId }

        // Create a new stream containing only the new track
        const newTrackStream = new MediaStream([consumer.track])

        // Create a NEW peer object by copying old properties
        // and adding the new stream. This is the key change.
        const updatedPeer: Peer = {
          ...oldPeer,
        }
        if (kind === "video") {
          updatedPeer.videoStream = newTrackStream
        } else if (kind === "audio") {
          updatedPeer.audioStream = newTrackStream
        }
        newPeers.set(peerId, updatedPeer)
        console.log(`Updated peer ${peerId} with ${kind} stream`)
        return newPeers
      })
    } catch (error) {
      console.error("Error in consume function:", error)
    }
  }

  const leaveRoom = () => {
    cleanup()
    router.push("/")
  }

  const toggleVideo = () => {
    if (isVideoOn) {
      stopVideo()
    } else {
      startVideo()
    }
  }

  const toggleAudio = () => {
    if (isAudioOn) {
      stopAudio()
    } else {
      startAudio()
    }
  }

  const cleanup = () => {
    // Stop all tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }
    // Close all producers
    producersRef.current.forEach((producer) => producer.close())
    producersRef.current.clear()
    // Close all consumers
    consumersRef.current.forEach((consumer) => consumer.close())
    consumersRef.current.clear()
    // Close transports
    if (producerTransportRef.current) {
      producerTransportRef.current.close()
      producerTransportRef.current = null
    }
    if (consumerTransportRef.current) {
      consumerTransportRef.current.close()
      consumerTransportRef.current = null
    }
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = null
    }
    setIsConnected(false)
    setIsVideoOn(false)
    setIsAudioOn(false)
    setPeers(new Map())
  }

  console.log("RoomPage rendering. Peers map:", peers)

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-900 text-lg">Connecting to room...</p>
          <p className="text-gray-600 text-sm mt-2">Room ID: {roomId}</p>
        </div>
      </div>
    )
  }

  if (error && !isConnected) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-6">
          <div className="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-gray-900 text-xl font-semibold mb-2">Connection Failed</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <div className="space-y-3">
            <button
              onClick={initializeConnection}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={() => router.push("/")}
              className="w-full bg-gray-600 hover:bg-gray-700 text-white px-6 py-3 rounded-lg transition-colors"
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    )
  }

  const totalParticipants = peers.size + 1
  const gridCols =
    totalParticipants === 1
      ? "grid-cols-1"
      : totalParticipants === 2
        ? "grid-cols-2"
        : totalParticipants <= 4
          ? "grid-cols-2"
          : totalParticipants <= 6
            ? "grid-cols-3"
            : "grid-cols-4"

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center space-x-4">
            <h1 className="text-gray-900 text-xl font-semibold">Room: {roomId}</h1>
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}></div>
              <span className="text-sm text-gray-600">{isConnected ? "Connected" : "Disconnected"}</span>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-gray-600 text-sm hidden sm:inline">
              {totalParticipants} participant
              {totalParticipants !== 1 ? "s" : ""}
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(window.location.href)}
              className="bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 px-4 py-2 rounded-lg transition-colors text-sm flex items-center"
              title="Copy room link"
            >
              <Copy className="w-4 h-4 inline mr-2" />
              <span className="hidden sm:inline">Copy Link</span>
            </button>
            <button
              onClick={leaveRoom}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Leave
            </button>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && isConnected && (
        <div className="bg-red-600 text-white p-3 text-center">
          {error}
          <button onClick={() => setError(null)} className="ml-4 underline hover:no-underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Video Grid */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="max-w-7xl mx-auto h-full">
          <div className={`grid gap-4 h-full ${gridCols}`}>
            {/* Local Video */}
            <div className="relative bg-gray-100 rounded-lg overflow-hidden min-h-[200px] lg:min-h-[300px] border border-gray-200">
              <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
              <div className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">
                You {!isVideoOn ? "(Camera off)" : ""}
              </div>
              <div className="absolute bottom-4 right-4 flex space-x-2">
                {isAudioOn && (
                  <div className="w-6 h-6 bg-green-600 rounded-full flex items-center justify-center">
                    <Mic className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
              {!isVideoOn && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-200">
                  <div className="text-center">
                    <div className="w-16 h-16 bg-gray-300 rounded-full flex items-center justify-center mx-auto mb-2">
                      <User className="w-8 h-8 text-gray-600" />
                    </div>
                    <p className="text-gray-700 text-sm">Camera off</p>
                  </div>
                </div>
              )}
            </div>

            {/* Remote Videos */}
            {Array.from(peers.values()).map((peer) => (
              <RemotePeer key={peer.id} peer={peer} />
            ))}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white border-t border-gray-200 p-4">
        <div className="flex items-center justify-center space-x-4">
          <button
            onClick={toggleVideo}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
              isVideoOn
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "bg-gray-200 hover:bg-gray-300 text-gray-700 border border-gray-300"
            }`}
            title={isVideoOn ? "Turn off camera" : "Turn on camera"}
          >
            {isVideoOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
          </button>
          <button
            onClick={toggleAudio}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
              isAudioOn
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "bg-gray-200 hover:bg-gray-300 text-gray-700 border border-gray-300"
            }`}
            title={isAudioOn ? "Turn off microphone" : "Turn on microphone"}
          >
            {isAudioOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
          </button>
          <button
            onClick={leaveRoom}
            className="w-12 h-12 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors"
            title="Leave room"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  )
}

function RemotePeer({ peer }: { peer: Peer }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // This effect handles attaching the video stream whenever it changes.
  useEffect(() => {
    if (videoRef.current) {
      if (peer.videoStream) {
        console.log(`Attaching video stream for peer ${peer.id}`)
        videoRef.current.srcObject = peer.videoStream
      } else {
        // If videoStream becomes null/undefined, clear the srcObject
        videoRef.current.srcObject = null
      }
    }
    // Cleanup function: when the component unmounts or peer.videoStream changes,
    // ensure the srcObject is cleared.
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [peer.videoStream]) // [^2]

  // This effect handles attaching the audio stream whenever it changes.
  useEffect(() => {
    if (audioRef.current) {
      if (peer.audioStream) {
        console.log(`Attaching audio stream for peer ${peer.id}`)
        audioRef.current.srcObject = peer.audioStream
      } else {
        // If audioStream becomes null/undefined, clear the srcObject
        audioRef.current.srcObject = null
      }
    }
    // Cleanup function: when the component unmounts or peer.audioStream changes,
    // ensure the srcObject is cleared.
    return () => {
      if (audioRef.current) {
        audioRef.current.srcObject = null
      }
    }
  }, [peer.audioStream]) // [^2]

  return (
    <div className="relative bg-gray-100 rounded-lg overflow-hidden min-h-[200px] lg:min-h-[300px] border border-gray-200">
      {/* The video element is always in the DOM but hidden.
          This makes the ref stable and ready.
      */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${peer.videoStream ? "block" : "hidden"}`}
      />

      {/* The audio element is non-visual, so it can always be present. */}
      <audio ref={audioRef} autoPlay />

      {/* Show the avatar/placeholder only when there is NO video stream */}
      {!peer.videoStream && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center bg-gray-200">
          <div className="text-center">
            <div className="w-16 h-16 bg-gray-300 rounded-full flex items-center justify-center mx-auto mb-2">
              <User className="w-8 h-8 text-gray-600" />
            </div>
            <p className="text-gray-700 text-sm">Camera off</p>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">
        {peer.id.substring(0, 8)} {!peer.videoStream ? "(Camera off)" : ""}
      </div>

      <div className="absolute bottom-4 right-4 flex space-x-2">
        {peer.audioStream && (
          <div className="w-6 h-6 bg-green-600 rounded-full flex items-center justify-center">
            <Mic className="w-3 h-3 text-white" />
          </div>
        )}
      </div>
    </div>
  )
}
