const { google } = require('googleapis');
const { encrypt, decrypt } = require('../utils/encryption');
const User = require('../models/User');
const Stream = require('../models/Stream');
const YoutubeChannel = require('../models/YoutubeChannel');
const fs = require('fs');
const path = require('path');

const loggedAlreadyHasBroadcast = new Set();

function getYouTubeOAuth2Client(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function omitUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function mapResolutionToYouTube(resolution) {
  if (!resolution) return '1080p';
  
  // Clean up resolution string if it contains extra info like "1920x1080 Full HD"
  const cleanRes = resolution.split(' ')[0];
  
  const mapping = {
    '426x240': '240p',
    '640x360': '360p',
    '854x480': '480p',
    '1280x720': '720p',
    '1920x1080': '1080p',
    '2560x1440': '1440p',
    '3840x2160': '2160p',
    '720x1280': '720p',  // Portrait
    '1080x1920': '1080p', // Portrait
    '1440x2560': '1440p', // Portrait
    '2160x3840': '2160p'  // Portrait
  };

  // Check if it's already in YouTube format (e.g. "2160p")
  if (Object.values(mapping).includes(cleanRes)) {
    return cleanRes;
  }

  const dimensionMatch = cleanRes.match(/^(\d+)x(\d+)$/);
  if (dimensionMatch) {
    const width = Number(dimensionMatch[1]);
    const height = Number(dimensionMatch[2]);
    const qualitySide = Math.min(width, height);

    if (qualitySide >= 2160) return '2160p';
    if (qualitySide > 1080) return '1440p';
    if (qualitySide >= 1080) return '1080p';
    if (qualitySide >= 720) return '720p';
    if (qualitySide >= 480) return '480p';
    if (qualitySide >= 360) return '360p';
    return '240p';
  }

  return '1080p';
}

function getThumbnailMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'image/jpeg';
  }
}

function resolveThumbnailPath(thumbnailPath) {
  if (!thumbnailPath) return null;

  const projectRoot = path.resolve(__dirname, '..');
  const normalized = thumbnailPath.replace(/\\/g, '/');
  const relPath = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const candidates = [];

  if (path.isAbsolute(thumbnailPath)) {
    candidates.push(thumbnailPath);
  }

  candidates.push(path.join(projectRoot, 'public', relPath));

  if (!relPath.startsWith('uploads/')) {
    candidates.push(path.join(projectRoot, 'public', 'uploads', 'thumbnails', relPath));
  }

  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (found) {
    return found;
  }
  
  // Log candidates if not found for debugging
  console.warn(`[YouTubeService] Could not resolve thumbnail path. Checked candidates:`, candidates);
  return candidates[0];
}

function handleYoutubeError(error, context = '') {
  const message = error.message || '';
  const errors = error.errors || [];
  
  const isQuotaError = message.toLowerCase().includes('quota') || 
                      errors.some(e => e.reason === 'quotaExceeded' || e.reason === 'rateLimitExceeded');
  const isAuthError = message.toLowerCase().includes('auth') || 
                     message.toLowerCase().includes('token') ||
                     message.toLowerCase().includes('invalid_grant') ||
                     errors.some(e => e.reason === 'authError' || e.reason === 'unauthorized');

  if (isQuotaError) {
    return new Error(`YouTube API Quota Habis (Limit Tercapai). Silakan tunggu reset otomatis (tengah malam waktu Pasifik) atau gunakan API Key lain. ${context}`);
  }
  
  if (isAuthError) {
    return new Error(`YouTube Token Kadaluwarsa atau Dicabut. Silakan putuskan (Disconnect) dan hubungkan kembali (Add Channel) di menu Integration. ${context}`);
  }

  return error;
}

async function syncBroadcastMonetization(youtube, broadcastId, enabled) {
  const broadcastResponse = await youtube.liveBroadcasts.list({
    part: 'id,snippet,contentDetails,status,monetizationDetails',
    id: broadcastId
  });

  const currentBroadcast = broadcastResponse.data.items?.[0];
  if (!currentBroadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const currentSnippet = currentBroadcast.snippet || {};
  const currentContentDetails = currentBroadcast.contentDetails || {};
  const currentStatus = currentBroadcast.status || {};
  const currentMonitorStream = currentContentDetails.monitorStream || {};
  const monitorStream = omitUndefined({
    enableMonitorStream: currentMonitorStream.enableMonitorStream,
    broadcastStreamDelayMs:
      currentMonitorStream.enableMonitorStream !== undefined
        ? currentMonitorStream.broadcastStreamDelayMs ?? 0
        : undefined
  });

  const requestBody = {
    id: broadcastId,
    snippet: omitUndefined({
      title: currentSnippet.title,
      description: currentSnippet.description || '',
      scheduledStartTime: currentSnippet.scheduledStartTime,
      scheduledEndTime: currentSnippet.scheduledEndTime
    }),
    contentDetails: omitUndefined({
      boundStreamId: currentContentDetails.boundStreamId,
      enableAutoStart: currentContentDetails.enableAutoStart,
      enableAutoStop: currentContentDetails.enableAutoStop,
      enableClosedCaptions: currentContentDetails.enableClosedCaptions,
      enableContentEncryption: currentContentDetails.enableContentEncryption,
      enableDvr: currentContentDetails.enableDvr,
      enableEmbed: currentContentDetails.enableEmbed,
      latencyPreference: currentContentDetails.latencyPreference,
      projection: currentContentDetails.projection,
      recordFromStart: currentContentDetails.recordFromStart,
      startWithSlate: currentContentDetails.startWithSlate,
      monitorStream: Object.keys(monitorStream).length > 0 ? monitorStream : undefined
    }),
    status: omitUndefined({
      privacyStatus: currentStatus.privacyStatus,
      selfDeclaredMadeForKids: currentStatus.selfDeclaredMadeForKids
    }),
    monetizationDetails: enabled
      ? {
          adsMonetizationStatus: 'ON',
          cuepointSchedule: {
            enabled: true,
            ytOptimizedCuepointConfig: 'MEDIUM'
          }
        }
      : {
          adsMonetizationStatus: 'OFF'
        }
  };

  await youtube.liveBroadcasts.update({
    part: 'id,snippet,contentDetails,status,monetizationDetails',
    requestBody
  });
}

async function createYouTubeBroadcast(streamId, baseUrl) {
  const stream = await Stream.findById(streamId);
  if (!stream) {
    throw new Error('Stream not found');
  }

  if (!stream.is_youtube_api) {
    return { success: true, message: 'Not a YouTube API stream' };
  }

    if (existingBroadcastId && existingRtmpUrl && existingStreamKey) {
        if (!loggedAlreadyHasBroadcast.has(streamId)) {
            console.log(`[YouTubeService] Stream ${streamId} already has broadcast ${existingBroadcastId}. Reusing.`);
            loggedAlreadyHasBroadcast.add(streamId);
        }
        broadcastId = existingBroadcastId;
        youtubeStreamId = existingStreamId;
        rtmpUrl = existingRtmpUrl;
        streamKey = existingStreamKey;
    }
  
  const user = await User.findById(stream.user_id);
  if (!user || !user.youtube_client_id || !user.youtube_client_secret) {
    throw new Error('YouTube API credentials not configured');
  }

  const selectedChannel = await YoutubeChannel.findById(stream.youtube_channel_id);
  if (!selectedChannel || !selectedChannel.access_token || !selectedChannel.refresh_token) {
    throw new Error('YouTube channel not found or not connected');
  }

  const clientSecret = decrypt(user.youtube_client_secret);
  const accessToken = decrypt(selectedChannel.access_token);
  const refreshToken = decrypt(selectedChannel.refresh_token);

  if (!clientSecret || !accessToken) {
    throw new Error('Failed to decrypt YouTube credentials');
  }

  const redirectUri = `${baseUrl}/auth/youtube/callback`;
  const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  oauth2Client.on('tokens', async (tokens) => {
    try {
      if (tokens.access_token) {
        await YoutubeChannel.update(selectedChannel.id, {
          access_token: encrypt(tokens.access_token)
        });
      }
      if (tokens.refresh_token) {
        await YoutubeChannel.update(selectedChannel.id, {
          refresh_token: encrypt(tokens.refresh_token)
        });
      }
    } catch (e) {
      console.error('[YouTubeService] Error saving automatic token refresh:', e.message);
    }
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const tagsArray = stream.youtube_tags ? stream.youtube_tags.split(',').map(t => t.trim()).filter(t => t) : [];

  let broadcast;
  let broadcastId = stream.youtube_broadcast_id;

  if (!broadcastId) {
    const broadcastSnippet = {
      title: stream.title,
      description: stream.youtube_description || '',
      scheduledStartTime: stream.schedule_time ? new Date(stream.schedule_time).toISOString() : new Date().toISOString()
    };

    console.log(`[YouTubeService] Creating YouTube broadcast for stream ${streamId}`);

    const broadcastData = {
        snippet: broadcastSnippet,
        contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
            monitorStream: {
                enableMonitorStream: false
            }
        },
        status: {
            privacyStatus: stream.youtube_privacy || 'unlisted',
            selfDeclaredMadeForKids: stream.made_for_kids === true || stream.made_for_kids === 1
        }
    };

    const broadcastResponse = await youtube.liveBroadcasts.insert({
        part: 'snippet,contentDetails,status',
        requestBody: broadcastData
    });

    broadcast = broadcastResponse.data;
    broadcastId = broadcast.id;
    console.log(`[YouTubeService] Created broadcast: ${broadcastId}`);
  } else {
    console.log(`[YouTubeService] Using existing broadcast: ${broadcastId}`);
    // broadcast may be undefined here; use broadcastId for all subsequent calls
  }

  if (stream.youtube_monetization) {
    try {
      await syncBroadcastMonetization(youtube, broadcastId, true);
      console.log(`[YouTubeService] Enabled monetization for broadcast ${broadcastId}`);
    } catch (monetizationError) {
      console.warn(`[YouTubeService] Failed to enable monetization for broadcast ${broadcastId}. Continuing without monetization. Error: ${monetizationError.message}`);
      await Stream.update(streamId, { youtube_monetization: false });
    }
  }

  if (tagsArray.length > 0 || stream.youtube_category) {
    try {
      // Optimization: Only update if it's a new broadcast or if metadata changed
      // For Autolive, we skip redundant updates if it was updated in the last 10 minutes
      const lastUpdate = stream.updated_at ? new Date(stream.updated_at).getTime() : 0;
      const now = Date.now();
      const isReused = !!stream.youtube_broadcast_id;
      // Update if it's new OR if more than 10 minutes have passed since last DB update
      const needsUpdate = !isReused || (now - lastUpdate > 600000); 

      if (needsUpdate) {
        const videoResponse = await youtube.videos.list({
          part: 'snippet',
          id: broadcastId
        });

        if (videoResponse.data.items && videoResponse.data.items.length > 0) {
          const currentSnippet = videoResponse.data.items[0].snippet;
          
          // Check if actually changed to save quota
          if (currentSnippet.title !== stream.title || 
              currentSnippet.description !== (stream.youtube_description || '') ||
              currentSnippet.categoryId !== (stream.youtube_category || '22')) {
            
            await youtube.videos.update({
              part: 'snippet',
              requestBody: {
                id: broadcastId,
                snippet: {
                  title: stream.title,
                  description: stream.youtube_description || '',
                  categoryId: stream.youtube_category || '22',
                  tags: tagsArray.length > 0 ? tagsArray : currentSnippet.tags,
                  defaultLanguage: currentSnippet.defaultLanguage,
                  defaultAudioLanguage: currentSnippet.defaultAudioLanguage
                }
              }
            });
            console.log(`[YouTubeService] Updated metadata for video ${broadcastId}`);
          }
        }
      }
    } catch (updateError) {
      console.log('[YouTubeService] Note: Could not update video metadata:', updateError.message);
    }
  }

  if (stream.youtube_thumbnail) {
    console.log(`[YouTubeService] Attempting thumbnail upload for ${broadcastId}: ${stream.youtube_thumbnail}`);
    try {
      const thumbnailPath = resolveThumbnailPath(stream.youtube_thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        console.log(`[YouTubeService] Found thumbnail file at: ${thumbnailPath}`);
        const thumbnailStream = fs.createReadStream(thumbnailPath);
        await youtube.thumbnails.set({
          videoId: broadcastId,
          media: {
            mimeType: getThumbnailMimeType(thumbnailPath),
            body: thumbnailStream
          }
        });
        console.log(`[YouTubeService] Uploaded thumbnail for broadcast ${broadcastId}`);
      } else {
        console.warn(`[YouTubeService] Thumbnail file not found at any resolved path: ${stream.youtube_thumbnail}`);
      }
    } catch (thumbError) {
      console.log('[YouTubeService] Note: Could not upload thumbnail:', thumbError.message);
      if (thumbError.response && thumbError.response.data) {
        console.log('[YouTubeService] Thumbnail Error Details:', JSON.stringify(thumbError.response.data, null, 2));
      }
    }
  }

  let rtmpUrl = stream.rtmp_url;
  let streamKey = stream.stream_key;
  let youtubeStreamId = stream.youtube_stream_id;

  if (!youtubeStreamId || !rtmpUrl || !streamKey) {
    const streamResponse = await youtube.liveStreams.insert({
        part: 'snippet,cdn,contentDetails,status',
        requestBody: {
            snippet: {
                title: `${stream.title} - Stream`
            },
            cdn: {
                frameRate: '30fps',
                ingestionType: 'rtmp',
                resolution: mapResolutionToYouTube(stream.resolution)
            },
            contentDetails: {
                isReusable: false
            }
        }
    });

    const liveStream = streamResponse.data;
    youtubeStreamId = liveStream.id;
    rtmpUrl = liveStream.cdn.ingestionInfo.ingestionAddress;
    streamKey = liveStream.cdn.ingestionInfo.streamName;
    console.log(`[YouTubeService] Created live stream: ${youtubeStreamId}`);

    try {
        await youtube.liveBroadcasts.bind({
            part: 'id,contentDetails',
            id: broadcastId,
            streamId: youtubeStreamId
        });
    } catch (bindError) {
        if (bindError.message && (bindError.message.toLowerCase().includes('binding') || bindError.message.toLowerCase().includes('allow'))) {
            console.warn(`[YouTubeService] Binding failed for stream ${streamId}, clearing IDs for retry: ${bindError.message}`);
            await Stream.update(streamId, {
                youtube_broadcast_id: '',
                youtube_stream_id: '',
                rtmp_url: '',
                stream_key: ''
            });
            throw new Error(`YouTube binding error: ${bindError.message}. Handled, will retry fresh.`);
        }
        throw bindError;
    }

    await Stream.update(streamId, {
      youtube_broadcast_id: broadcastId,
      youtube_stream_id: youtubeStreamId,
      rtmp_url: rtmpUrl,
      stream_key: streamKey
    });
  }

  // CRITICAL FIX: Always ensure binding even if reusing IDs
  // This prevents the "Ghost Stream" / Double Thumbnail issue
  if (broadcastId && youtubeStreamId) {
      try {
          const checkBroadcast = await youtube.liveBroadcasts.list({
              part: 'contentDetails',
              id: broadcastId
          });
          
          const boundId = checkBroadcast.data.items?.[0]?.contentDetails?.boundStreamId;
          if (boundId !== youtubeStreamId) {
              console.log(`[YouTubeService] Re-binding broadcast ${broadcastId} to stream ${youtubeStreamId}`);
              await youtube.liveBroadcasts.bind({
                  part: 'id,contentDetails',
                  id: broadcastId,
                  streamId: youtubeStreamId
              });
          }
      } catch (bindError) {
          console.warn(`[YouTubeService] Binding check/re-bind failed:`, bindError.message);
      }
  }

  // Handle Playlist Assignment
  if (stream.youtube_playlist_id) {
    try {
      console.log(`[YouTubeService] Adding broadcast ${broadcastId} to playlist ${stream.youtube_playlist_id}`);
      await youtube.playlistItems.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            playlistId: stream.youtube_playlist_id,
            resourceId: {
              kind: 'youtube#video',
              videoId: broadcastId
            }
          }
        }
      });
      console.log(`[YouTubeService] Successfully added to playlist`);
    } catch (playlistError) {
      console.warn(`[YouTubeService] Failed to add broadcast to playlist: ${playlistError.message}`);
    }
  }

  console.log(`[YouTubeService] YouTube broadcast handled successfully for stream ${streamId}`);

  return {
    success: true,
    broadcastId: broadcastId,
    streamId: youtubeStreamId,
    rtmpUrl: rtmpUrl,
    streamKey: streamKey
  };
}

async function getYoutubeInstance(userId, channelId) {
  const user = await User.findById(userId);
  const selectedChannel = await YoutubeChannel.findById(channelId);
  if (!user || !selectedChannel || !selectedChannel.access_token) return null;
  
  const clientSecret = decrypt(user.youtube_client_secret);
  const accessToken = decrypt(selectedChannel.access_token);
  const refreshToken = decrypt(selectedChannel.refresh_token);
  
  const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
  const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, baseUrl);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function getChannelStats(userId, channelId) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) return null;
    const res = await youtube.channels.list({ part: 'statistics,snippet', mine: true });
    if (res.data.items && res.data.items.length > 0) {
      return res.data.items[0];
    }
    return null;
  } catch (e) {
    console.log('[YouTubeService] Error getting channel stats:', e.message);
    return null;
  }
}

async function getLiveStreamMetrics(userId, channelId, broadcastId) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) return null;
    const res = await youtube.videos.list({ part: 'liveStreamingDetails', id: broadcastId });
    if (res.data.items && res.data.items.length > 0) {
      return res.data.items[0].liveStreamingDetails;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function deleteYouTubeBroadcast(streamId) {
  try {
    loggedAlreadyHasBroadcast.delete(streamId);
    
    const stream = await Stream.findById(streamId);
    if (!stream || !stream.is_youtube_api || !stream.youtube_broadcast_id) {
      return { success: true, message: 'No YouTube broadcast to clean up' };
    }

    try {
      const youtube = await getYoutubeInstance(stream.user_id, stream.youtube_channel_id);
      if (youtube) {
        await youtube.liveBroadcasts.transition({
          part: 'id,status',
          broadcastStatus: 'complete',
          id: stream.youtube_broadcast_id
        });
        console.log(`[YouTubeService] Successfully forced broadcast to complete: ${stream.youtube_broadcast_id}`);
      }
    } catch (e) {
      console.log(`[YouTubeService] Note: Could not transition broadcast to complete (${e.message})`);
    }

    await Stream.update(streamId, {
      youtube_broadcast_id: '',
      youtube_stream_id: '',
      rtmp_url: '',
      stream_key: ''
    });

    console.log(`[YouTubeService] Cleared YouTube credentials for stream ${streamId}`);

    return { success: true };
  } catch (error) {
    console.error('[YouTubeService] Error clearing YouTube broadcast data:', error);
    return { success: false, error: error.message };
  }
}

async function getStreamHealth(userId, channelId, youtubeStreamId) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) return null;
    
    const res = await youtube.liveStreams.list({
      part: 'status',
      id: youtubeStreamId
    });

    if (res.data.items && res.data.items.length > 0) {
      return res.data.items[0].status.healthStatus || { status: 'nodata' };
    }
    return { status: 'nodata' };
  } catch (e) {
    console.error('[YouTubeService] Error getting stream health:', e.message);
    return null;
  }
}

async function getPlaylistItems(userId, channelId, playlistId) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) throw new Error('Could not get YouTube instance');

    const response = await youtube.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId: playlistId,
      maxResults: 50
    });

    return response.data.items.map(item => ({
      title: item.snippet.title,
      description: item.snippet.description,
      videoId: item.contentDetails.videoId,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url
    }));
  } catch (error) {
    console.error('[YouTubeService] Error fetching playlist items:', error.message);
    throw handleYoutubeError(error, `(Playlist: ${playlistId})`);
  }
}

async function uploadVideoToYoutube(userId, channelId, filePath, metadata) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) throw new Error('Could not get YouTube instance');

    const fileSize = fs.statSync(filePath).size;
    
    console.log(`[YouTubeService] Starting upload for ${filePath} (${fileSize} bytes)`);

    const res = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: metadata.title,
          description: metadata.description || '',
          tags: metadata.tags ? metadata.tags.split(',').map(t => t.trim()) : [],
          categoryId: metadata.category || '22',
        },
        status: {
          privacyStatus: metadata.privacy || 'unlisted',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    }, {
      onUploadProgress: evt => {
        if (metadata.onProgress) {
          const progress = Math.round((evt.bytesRead / fileSize) * 100);
          metadata.onProgress(progress);
        }
      }
    });

    console.log(`[YouTubeService] Upload successful! Video ID: ${res.data.id}`);
    return { success: true, videoId: res.data.id };
  } catch (error) {
    const betterError = handleYoutubeError(error, `(Upload: ${metadata.title})`);
    console.error('[YouTubeService] Error uploading video:', betterError.message);
    throw betterError;
  }
}

async function updateLiveMetadata(userId, channelId, broadcastId, metadata) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) throw new Error('Could not get YouTube instance');

    console.log(`[YouTubeService] Updating live metadata for broadcast ${broadcastId}`);

    // 1. Update Title and Description
    // Note: We need to get current categoryId if not provided because it's required for snippet update
    let categoryId = metadata.category || '22';
    try {
      const videoRes = await youtube.videos.list({ part: 'snippet', id: broadcastId });
      if (videoRes.data.items && videoRes.data.items.length > 0) {
        categoryId = videoRes.data.items[0].snippet.categoryId;
      }
    } catch (e) {
      console.warn('[YouTubeService] Could not fetch current category, using default');
    }

    const tagsArray = metadata.tags
      ? metadata.tags.split(',').map(tag => tag.trim()).filter(Boolean)
      : [];

    await youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: broadcastId,
        snippet: {
          title: metadata.title,
          description: metadata.description || '',
          categoryId: categoryId,
          tags: tagsArray.length > 0 ? tagsArray : undefined
        }
      }
    });

    // 2. Update Thumbnail if provided
    if (metadata.thumbnail_path) {
      const fullThumbnailPath = resolveThumbnailPath(metadata.thumbnail_path);
      
      if (fs.existsSync(fullThumbnailPath)) {
        const thumbnailStream = fs.createReadStream(fullThumbnailPath);
        await youtube.thumbnails.set({
          videoId: broadcastId,
          media: {
            mimeType: getThumbnailMimeType(fullThumbnailPath),
            body: thumbnailStream
          }
        });
        console.log(`[YouTubeService] Mid-stream thumbnail updated for ${broadcastId}`);
      } else {
        console.warn(`[YouTubeService] Thumbnail file not found, skipping metadata thumbnail update: ${metadata.thumbnail_path}`);
      }
    }

    return { success: true };
  } catch (error) {
    const betterError = handleYoutubeError(error, `(Metadata Update: ${broadcastId})`);
    console.error('[YouTubeService] Error updating live metadata:', betterError.message);
    throw betterError;
  }
}

async function getPlaylists(userId, channelId) {
  try {
    const youtube = await getYoutubeInstance(userId, channelId);
    if (!youtube) return [];
    
    let playlists = [];
    let pageToken = null;
    
    do {
      const res = await youtube.playlists.list({
        part: 'snippet,contentDetails',
        mine: true,
        maxResults: 50,
        pageToken: pageToken
      });
      
      if (res.data.items) {
        playlists = playlists.concat(res.data.items.map(p => ({
          id: p.id,
          title: p.snippet.title,
          description: p.snippet.description,
          thumbnail: p.snippet.thumbnails?.default?.url || p.snippet.thumbnails?.medium?.url,
          itemCount: p.contentDetails.itemCount
        })));
      }
      
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    
    return playlists;
  } catch (e) {
    console.error('[YouTubeService] Error fetching playlists:', e.message);
    return [];
  }
}

module.exports = {
  createYouTubeBroadcast,
  deleteYouTubeBroadcast,
  getYouTubeOAuth2Client,
  syncBroadcastMonetization,
  getChannelStats,
  getLiveStreamMetrics,
  getStreamHealth,
  handleYoutubeError,
  getYoutubeInstance,
  uploadVideoToYoutube,
  mapResolutionToYouTube,
  updateLiveMetadata,
  getPlaylists,
  getPlaylistItems
};
