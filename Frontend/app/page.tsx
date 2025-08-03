"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Video, Lock, Zap, Smartphone } from "lucide-react"

export default function Home() {
  const [roomId, setRoomId] = useState("")
  const [isJoining, setIsJoining] = useState(false)
  const router = useRouter()

  const generateRoomId = () => {
    const randomId = Math.random().toString(36).substring(2, 8)
    setRoomId(randomId)
  }

  const joinRoom = async () => {
    if (!roomId.trim()) return
    setIsJoining(true)
    router.push(`/room/${roomId}`)
    setIsJoining(false)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      joinRoom()
    }
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4">
      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <div className="mb-4">
            <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-md">
              <Video className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-2">VideoCall</h1>
            <p className="text-gray-600 text-lg">Connect with anyone, anywhere</p>
          </div>
        </div>

        {/* Main Card */}
        <Card className="w-full max-w-md mx-auto shadow-lg border-gray-200">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-semibold">Join or Create a Room</CardTitle>
            <CardDescription>Enter a room ID or generate a new one to start your call.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <label htmlFor="roomId" className="block text-sm font-medium text-gray-700 mb-2">
                Room ID
              </label>
              <Input
                id="roomId"
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter room ID or generate one"
                className="w-full"
              />
            </div>
            <Button onClick={generateRoomId} variant="outline" className="w-full py-2 bg-transparent">
              Generate Random Room ID
            </Button>
            <Button
              onClick={joinRoom}
              disabled={!roomId.trim() || isJoining}
              className="w-full py-3 text-lg font-semibold"
            >
              {isJoining ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Joining...
                </>
              ) : (
                <>
                  <Video className="w-5 h-5 mr-2" />
                  <span>Join Room</span>
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Features */}
        <div className="mt-8 text-center">
          <div className="grid grid-cols-3 gap-4 text-gray-700">
            <div className="flex flex-col items-center space-y-2">
              <Lock className="w-6 h-6 text-blue-600" />
              <span className="text-xs font-medium">Secure</span>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Zap className="w-6 h-6 text-blue-600" />
              <span className="text-xs font-medium">Fast</span>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Smartphone className="w-6 h-6 text-blue-600" />
              <span className="text-xs font-medium">Mobile</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
