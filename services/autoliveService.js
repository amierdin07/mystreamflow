const Autolive = require('../models/Autolive');
const Stream = require('../models/Stream');
const youtubeService = require('./youtubeService');
const streamingService = require('./streamingService');
const { db } = require('../db/database');
const path = require('path');
const fs = require('fs');

let checkInterval = null;

class AutoliveService {
  static init() {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = setInterval(() => this.checkAutoliveSeries(), 60000);
    console.log('Autolive Service initialized');
    this.checkAutoliveSeries(); // Run once immediately
  }

  static async checkAutoliveSeries() {
    try {
      const activeSeries = await Autolive.findActiveSeries();
      const now = new Date();

      for (const series of activeSeries) {
        await this.processSeries(series, now);
      }
    } catch (error) {
      console.error('Error in Autolive check:', error);
    }
  }

  static async processSeries(series, now) {
    const items = await Autolive.getItemsBySeriesId(series.id);
    if (items.length === 0) return;

    // STOP if all items are already used
    if (series.current_item_index >= items.length) {
      console.log(`[Autolive] Series "${series.name}" finished all items. Stopping series.`);
      await Autolive.update(series.id, { is_active: 0, status: 'offline' });
      return;
    }

    // Calculate the most relevant start time (could be in the past if we are currently within the duration)
    let sessionStart = new Date(series.start_time);
    const durationMs = (series.duration || 0) * 60 * 1000;
    
    // Find the session start time that covers 'now'
    if (series.repeat_mode !== 'none' && series.repeat_mode !== 'custom') {
      // For repeating ones, we need to find the start of the CURRENT session
      // This is a simplified approach: we look for the most recent occurrence
      // We start from the original start_time and keep adding intervals until we just passed 'now'
      // then take the one before that.
      let checkStart = new Date(series.start_time);
      while (checkStart <= now) {
        sessionStart = new Date(checkStart);
        // Move to next to check
        checkStart = this.getNextStartTime(checkStart.toISOString(), series.repeat_mode);
        if (checkStart > now) break; 
      }
    } else if (series.repeat_mode === 'custom' && series.custom_dates) {
      // For custom dates, find the date that is currently "active"
      try {
        const dates = JSON.parse(series.custom_dates);
        const activeDate = dates.find(d => {
          const dStart = new Date(d);
          const timePart = new Date(series.start_time);
          dStart.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
          const dEnd = new Date(dStart.getTime() + durationMs);
          return now >= dStart && now < dEnd;
        });
        if (activeDate) {
          sessionStart = new Date(activeDate);
          const timePart = new Date(series.start_time);
          sessionStart.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
        } else {
          // If none active, find the future one
          sessionStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates);
        }
      } catch(e) {}
    } else {
      // One-time session
      sessionStart = new Date(series.start_time);
    }

    const sessionEnd = new Date(sessionStart.getTime() + durationMs);

    // 1. YouTube Pre-Sync (2 Hours before NEXT start)
    const futureStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates);
    if (series.status === 'offline' && !series.youtube_broadcast_id) {
      const timeToStart = futureStart - now;
      if (timeToStart > 0 && timeToStart <= 2 * 60 * 60 * 1000) {
        console.log(`[Autolive] Pre-syncing series "${series.name}" to YouTube (2h window)`);
        await this.syncToYouTube(series);
      }
    }

    // 2. Start Live (If we are within a session window)
    if (series.status === 'offline' && now >= sessionStart && now < sessionEnd) {
      console.log(`[Autolive] Starting live for series "${series.name}" (Within window)`);
      await this.startAutoliveStream(series);
    }

    // 3. Stop Live
    if (series.status === 'live' && now >= nextEnd) {
      console.log(`[Autolive] Stopping live for series "${series.name}" (Duration reached)`);
      await this.stopAutoliveStream(series);
    }

    // 4. Mid-Stream Auto-Swap (24 Hours+)
    if (series.status === 'live') {
      const lastUpdate = series.last_metadata_update ? new Date(series.last_metadata_update) : new Date(series.start_time);
      const timeSinceUpdate = now - lastUpdate;
      if (timeSinceUpdate >= 24 * 60 * 60 * 1000) {
        console.log(`[Autolive] Mid-stream auto-swap for series "${series.name}" (24h reached)`);
        await this.swapMetadataMidStream(series);
      }
    }
  }

  static getNextStartTime(startTimeStr, repeatMode, customDatesStr = null) {
    if (!startTimeStr) return new Date(8640000000000000); // Far future
    let nextStart = new Date(startTimeStr);
    const now = new Date();

    // CUSTOM DATES LOGIC
    if (repeatMode === 'custom' && customDatesStr) {
      try {
        const dates = JSON.parse(customDatesStr);
        const futureDates = dates
          .map(d => {
            const datePart = new Date(d);
            const timePart = new Date(startTimeStr);
            datePart.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
            return datePart;
          })
          .filter(d => d > now)
          .sort((a, b) => a - b);
        
        if (futureDates.length > 0) return futureDates[0];
        // If no more future dates, return far future to effectively stop
        return new Date(8640000000000000);
      } catch (e) {
        console.error('Error parsing custom dates:', e);
      }
    }

    if (nextStart > now) return nextStart;

    // If it's a one-time thing and already passed
    if (repeatMode === 'none' || !repeatMode) return nextStart;

    const dayMap = {
      'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
      'thursday': 4, 'friday': 5, 'saturday': 6
    };

    if (dayMap[repeatMode] !== undefined) {
      const targetDay = dayMap[repeatMode];
      // Ensure the first run is on the correct day
      while (nextStart.getDay() !== targetDay) {
        nextStart.setDate(nextStart.getDate() + 1);
      }
      
      // If that calculated start is still in the past, move to next week
      while (nextStart <= now) {
        nextStart.setDate(nextStart.getDate() + 7);
      }
      return nextStart;
    }

    while (nextStart <= now) {
      switch (repeatMode) {
        case 'daily': nextStart.setDate(nextStart.getDate() + 1); break;
        case 'weekly': nextStart.setDate(nextStart.getDate() + 7); break;
        case 'every_2_days': nextStart.setDate(nextStart.getDate() + 2); break;
        case 'every_3_days': nextStart.setDate(nextStart.getDate() + 3); break;
        case 'every_4_days': nextStart.setDate(nextStart.getDate() + 4); break;
        case 'every_5_days': nextStart.setDate(nextStart.getDate() + 5); break;
        default: return nextStart;
      }
    }
    return nextStart;
  }

  static async syncToYouTube(series) {
    try {
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length === 0) return;

      const currentItem = items[series.current_item_index % items.length];
      
      // Create a dummy stream object for YouTube service
      const dummyStreamId = `autolive_${series.id}`;
      const dummyStream = {
        id: dummyStreamId,
        user_id: series.user_id,
        title: currentItem.title,
        youtube_description: currentItem.description || '',
        youtube_tags: currentItem.tags || '',
        youtube_category: '22',
        youtube_privacy: 'public',
        youtube_channel_id: series.youtube_channel_id,
        youtube_thumbnail: currentItem.thumbnail_path,
        schedule_time: this.getNextStartTime(series.start_time, series.repeat_mode).toISOString()
      };

      // We need to temporarily save this dummy stream to the DB so youtubeService can find it
      // OR we modify youtubeService to accept an object. 
      // Let's use a more robust way: create/update a dedicated stream record for this series.
      let streamRecord = await this.getOrCreateStreamRecord(series);
      
      // Update stream record with current item metadata and series settings
      await Stream.update(streamRecord.id, {
        title: currentItem.title,
        video_id: series.internal_playlist_id || series.video_id,
        youtube_description: currentItem.description || '',
        youtube_tags: currentItem.tags || '',
        youtube_thumbnail: currentItem.thumbnail_path,
        schedule_time: dummyStream.schedule_time,
        youtube_privacy: series.privacy || 'public',
        youtube_category: series.category_id || '24',
        youtube_monetization: series.monetization_enabled === 1 ? 1 : 0,
        made_for_kids: series.made_for_kids === 1 ? 1 : 0,
        youtube_playlist_id: series.playlist_id || null
      });

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await youtubeService.createYouTubeBroadcast(streamRecord.id, baseUrl);
      
      if (result) {
        const updatedStream = await Stream.findById(streamRecord.id);
        await Autolive.update(series.id, {
          youtube_broadcast_id: updatedStream.youtube_broadcast_id,
          youtube_stream_id: updatedStream.youtube_stream_id,
          rtmp_url: updatedStream.rtmp_url,
          stream_key: updatedStream.stream_key
        });
      }
    } catch (error) {
      console.error(`[Autolive] Sync failed for "${series.name}":`, error);
    }
  }

  static async getOrCreateStreamRecord(series) {
    const streamId = `autolive_${series.id}`;
    let stream = await Stream.findById(streamId);
    if (!stream) {
      // For Autolive, we can use the video_id field in the streams table for both single video or playlist,
      // as the streamingService handles it based on ID lookup in videos or playlists table.
      const sourceId = series.internal_playlist_id || series.video_id;
      
      await db.run(
        `INSERT INTO streams (id, user_id, title, video_id, rtmp_url, stream_key, platform, status, is_youtube_api, youtube_channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [streamId, series.user_id, series.name, sourceId, '', '', 'YouTube', 'scheduled', 1, series.youtube_channel_id]
      );
      stream = await Stream.findById(streamId);
    }
    return stream;
  }

  static async startAutoliveStream(series) {
    try {
      const streamId = `autolive_${series.id}`;
      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      
      const result = await streamingService.startStream(streamId, false, baseUrl);
      if (result.success) {
        await Autolive.update(series.id, { 
          status: 'live',
          last_metadata_update: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[Autolive] Start failed for "${series.name}":`, error);
    }
  }

  static async stopAutoliveStream(series) {
    try {
      const streamId = `autolive_${series.id}`;
      await streamingService.stopStream(streamId);
      
      await Autolive.update(series.id, { 
        status: 'offline',
        youtube_broadcast_id: null,
        youtube_stream_id: null,
        current_item_index: series.current_item_index + 1
      });
    } catch (error) {
      console.error(`[Autolive] Stop failed for "${series.name}":`, error);
    }
  }

  static async swapMetadataMidStream(series) {
    try {
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length <= 1) return;

      const nextIndex = (series.current_item_index + 1) % items.length;
      const nextItem = items[nextIndex];
      const streamId = `autolive_${series.id}`;
      const stream = await Stream.findById(streamId);

      if (!stream.youtube_broadcast_id) return;

      console.log(`[Autolive] Swapping to next metadata: ${nextItem.title}`);
      
      // Update YouTube via Service
      const user = await require('../models/User').findById(series.user_id);
      const YoutubeChannel = require('../models/YoutubeChannel');
      const channel = await YoutubeChannel.findById(series.youtube_channel_id);
      
      if (user && channel) {
        // Use the existing logic from app.js or youtubeService to update metadata
        // For simplicity, we'll implement a call to a new helper in youtubeService
        await youtubeService.updateLiveMetadata(series.user_id, series.youtube_channel_id, stream.youtube_broadcast_id, {
          title: nextItem.title,
          description: nextItem.description || '',
          thumbnail_path: nextItem.thumbnail_path
        });

        await Autolive.update(series.id, {
          current_item_index: nextIndex,
          last_metadata_update: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[Autolive] Mid-stream swap failed for "${series.name}":`, error);
    }
  }
}

module.exports = AutoliveService;
