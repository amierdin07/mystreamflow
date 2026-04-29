const youtubeService = require('../services/youtubeService');
const Stream = require('../models/Stream');
const Autolive = require('../models/Autolive');

async function test() {
  try {
    // Let's find the stream we saw in the debug logs
    const streamId = '8f1ce56c-769b-480d-8c38-b304d61ccb00';
    const stream = await Stream.findById(streamId);
    
    if (!stream) {
        console.error('Stream not found');
        process.exit(1);
    }
    
    console.log('Stream found:', stream.title);
    console.log('Current thumbnail in DB:', stream.youtube_thumbnail);
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
    
    console.log('Attempting to create/update YouTube broadcast...');
    const result = await youtubeService.createYouTubeBroadcast(streamId, baseUrl);
    
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Test failed:', e);
    process.exit(1);
  }
}

test();
