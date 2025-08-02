import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { config } from '../config';

export const hlsRouter = express.Router();

// Serve HLS manifest files (.m3u8)
hlsRouter.get('/:roomId.m3u8', async (req, res) => {
  try {
    const { roomId } = req.params;
    const manifestPath = path.join(config.hls.outputPath, `${roomId}.m3u8`);
    
    // Check if file exists
    await fs.access(manifestPath);
    
    // Set appropriate headers for HLS
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Send the manifest file
    res.sendFile(manifestPath);
    
  } catch (error) {
    console.error('Error serving HLS manifest:', error);
    res.status(404).json({ error: 'HLS stream not found' });
  }
});

// Serve HLS segment files (.ts)
hlsRouter.get('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    // Check if it's a segment file (ends with .ts)
    if (filename.endsWith('.ts')) {
      const segmentPath = path.join(config.hls.outputPath, filename);
      
      // Check if file exists
      await fs.access(segmentPath);
      
      // Set appropriate headers for video segments
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'max-age=10');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      // Send the segment file
      res.sendFile(segmentPath);
    } else {
      res.status(404).json({ error: 'File not found' });
    }
    
  } catch (error) {
    console.error('Error serving HLS segment:', error);
    res.status(404).json({ error: 'HLS segment not found' });
  }
});

// Get HLS stream info
hlsRouter.get('/info/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const manifestPath = path.join(config.hls.outputPath, `${roomId}.m3u8`);
    
    // Check if stream exists
    await fs.access(manifestPath);
    
    res.json({
      roomId,
      hlsUrl: `/hls/${roomId}.m3u8`,
      status: 'active'
    });
    
  } catch (error) {
    res.status(404).json({ 
      roomId: req.params.roomId,
      status: 'inactive',
      error: 'Stream not found' 
    });
  }
});