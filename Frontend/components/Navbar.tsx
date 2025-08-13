"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Video, Home, Clock } from "lucide-react";

const Navbar = () => {
  const pathname = usePathname();
  const [currentTime, setCurrentTime] = useState<string>("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      // Convert to IST (Indian Standard Time)
      const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const timeString = istTime.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
      const dateString = istTime.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      setCurrentTime(`${dateString} ${timeString} IST`);
    };

    // Update immediately
    updateTime();
    
    // Update every second
    const interval = setInterval(updateTime, 1000);

    return () => clearInterval(interval);
  }, []);

  const isActive = (path: string) => pathname === path;

  return (
    <nav className="bg-white border-b border-gray-200 px-4 py-3 shadow-sm">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Logo/Brand */}
        <div className="flex items-center space-x-2">
          <Video className="h-6 w-6 text-blue-600" />
          <span className="text-xl font-bold text-gray-900">WebRTC Hub</span>
        </div>

        {/* Navigation Links */}
        <div className="flex items-center space-x-4">
          <Link href="/">
            <Button
              variant={isActive("/") ? "default" : "ghost"}
              className="flex items-center space-x-2"
            >
              <Home className="h-4 w-4" />
              <span>Home</span>
            </Button>
          </Link>
          
          <Link href="/watch">
            <Button
              variant={isActive("/watch") ? "default" : "ghost"}
              className="flex items-center space-x-2"
            >
              <Video className="h-4 w-4" />
              <span>Watch</span>
            </Button>
          </Link>
        </div>

        {/* Time Display */}
        <div className="flex items-center space-x-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
          <Clock className="h-4 w-4" />
          <span className="font-mono">{currentTime}</span>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;