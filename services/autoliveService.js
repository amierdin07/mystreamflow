const Autolive = require('../models/Autolive');
const Stream = require('../models/Stream');
const youtubeService = require('./youtubeService');
const streamingService = require('./streamingService');
const { db } = require('../db/database');
const path = require('path');
const fs = require('fs');

let checkInterval = null;

// Parse start_time from DB. Handles both:
// - New ISO UTC strings ("2026-04-27T10:20:00.000Z") - from browser UTC conversion
// - Old local strings ("2026-04-27T17:20") - from old data without timezone
function parseLocalDateTime(dtStr) {
  if (!dtStr) return new Date(NaN);
  // If it has timezone info (Z or +), it's a proper ISO string - parse directly
  if (dtStr.includes('Z') || dtStr.includes('+') || /T\d{2}:\d{2}:\d{2}-/.test(dtStr)) {
    return new Date(dtStr);
  }
  // Old format without timezone (e.g. "2026-04-27T17:20")
  // Use Date constructor with individual parts to treat as LOCAL time
  const [datePart, timePart = '0:0:0'] = dtStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

function getSeriesTimeZone(series) {
  return series.timezone || process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Bangkok';
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdays[map.weekday]
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - date.getTime();
}

function makeDateInTimeZone(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let result = new Date(utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), timeZone));
  result = new Date(utcGuess - getTimeZoneOffsetMs(result, timeZone));
  return result;
}

function addDaysToZonedParts(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second || 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second || 0
  };
}

class AutoliveService {
  static async init() {
    if (checkInterval) clearInterval(checkInterval);

    // FIX #1: Reset any autolive series still stuck in 'live' state on server restart.
    // When server crashes/restarts, the stream is gone but status stays 'live', blocking re-start.
    try {
      await new Promise((resolve, reject) => {
        const { db } = require('../db/database');
        db.run(`UPDATE autolive_series SET status = 'offline' WHERE status = 'live'`, [], function(err) {
          if (err) { console.error('[Autolive] Failed to reset stale live statuses:', err.message); }
          else if (this.changes > 0) { console.log(`[Autolive] Reset ${this.changes} stale 'live' series to 'offline'`); }
          resolve();
        });
      });
    } catch (e) { console.error('[Autolive] Error resetting stale statuses:', e); }

    checkInterval = setInterval(() => this.checkAutoliveSeries(), 60000);
    console.log('Autolive Service initialized');
    this.checkAutoliveSeries(); // Run once immediately
  }

  static async checkAutoliveSeries() {
    try {
      const activeSeries = await Autolive.findActiveSeries();
      const now = new Date();

      for (const series of activeSeries) {
        try {
          await this.processSeries(series, now);
        } catch (seriesError) {
          console.error(`[Autolive] Error processing series "${series.name || series.id}":`, seriesError);
        }
      }
    } catch (error) {
      console.error('Error in Autolive check:', error);
    }
  }

  static async processSeries(series, now) {
    const items = await Autolive.getItemsBySeriesId(series.id);
    if (items.length === 0) {
      console.log(`[Autolive] Series "${series.name}" skipped: no metadata items`);
      return;
    }

    // STOP if all items are already used
    if (series.current_item_index >= items.length) {
      console.log(`[Autolive] Series "${series.name}" finished all items. Stopping series.`);
      await Autolive.update(series.id, { is_active: 0, status: 'offline' });
      return;
    }

    const timeZone = getSeriesTimeZone(series);

    // FIX #2 & #3: Properly calculate which session window 'now' falls into.
    let sessionStart = parseLocalDateTime(series.start_time);
    if (!series.start_time || isNaN(sessionStart.getTime())) {
      console.error(`[Autolive] Series "${series.name}" skipped: invalid start_time "${series.start_time}"`);
      return;
    }

    // FIX #3: durationMs must be at least 1 minute to avoid zero-window. If user set 0, default to 60 min.
    const rawDurationMs = (series.duration || 0) * 60 * 1000;
    const durationMs = rawDurationMs > 0 ? rawDurationMs : 60 * 60 * 1000;
    
    // Find the most recent session start that is <= now (i.e. the session currently active or the last one).
    if (series.repeat_mode !== 'none' && series.repeat_mode !== 'custom') {
      sessionStart = this.getCurrentSessionStart(series.start_time, series.repeat_mode, now, timeZone);
    } else if (series.repeat_mode === 'custom' && series.custom_dates) {
      try {
        const dates = JSON.parse(series.custom_dates);
        const activeDate = dates.find(d => {
          const timeParts = getZonedParts(parseLocalDateTime(series.start_time), timeZone);
          const dateParts = getZonedParts(makeDateInTimeZone({ ...timeParts, year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) }, timeZone), timeZone);
          const dStart = makeDateInTimeZone({ ...dateParts, hour: timeParts.hour, minute: timeParts.minute, second: 0 }, timeZone);
          const dEnd = new Date(dStart.getTime() + durationMs);
          return now >= dStart && now < dEnd;
        });
        if (activeDate) {
          const timeParts = getZonedParts(parseLocalDateTime(series.start_time), timeZone);
          sessionStart = makeDateInTimeZone({
            year: Number(activeDate.slice(0, 4)),
            month: Number(activeDate.slice(5, 7)),
            day: Number(activeDate.slice(8, 10)),
            hour: timeParts.hour,
            minute: timeParts.minute,
            second: 0
          }, timeZone);
        } else {
          sessionStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, timeZone);
        }
      } catch(e) { console.error('[Autolive] Error parsing custom dates:', e); }
    } else {
      // One-time session
      sessionStart = parseLocalDateTime(series.start_time);
    }

    const sessionEnd = new Date(sessionStart.getTime() + durationMs);
    console.log(`[Autolive] "${series.name}" | now=${now.toISOString()} sessionStart=${sessionStart.toISOString()} sessionEnd=${sessionEnd.toISOString()} status=${series.status}`);
    const isReadyToStart = this.isReadyToStart(series.status);

    // 1. YouTube Pre-Sync (2 Hours before NEXT start)
    const futureStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, timeZone);
    if (isReadyToStart && !series.youtube_broadcast_id) {
      const timeToStart = futureStart - now;
      if (timeToStart > 0 && timeToStart <= 2 * 60 * 60 * 1000) {
        console.log(`[Autolive] Pre-syncing series "${series.name}" to YouTube (2h window)`);
        await this.syncToYouTube(series);
      }
    }

    // 2. Start Live (If we are within a session window)
    if (isReadyToStart && now >= sessionStart && now < sessionEnd) {
      console.log(`[Autolive] Starting live for series "${series.name}" (Within window)`);
      await this.startAutoliveStream(series);
    }

    // 3. Stop Live
    if (series.status === 'live' && now >= sessionEnd) {
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

  static getNextStartTime(startTimeStr, repeatMode, customDatesStr = null, timeZone = 'Asia/Bangkok') {
    if (!startTimeStr) return new Date(8640000000000000); // Far future
    let nextStart = parseLocalDateTime(startTimeStr);
    const now = new Date();

    // CUSTOM DATES LOGIC
    if (repeatMode === 'custom' && customDatesStr) {
      try {
        const dates = JSON.parse(customDatesStr);
        const timeParts = getZonedParts(parseLocalDateTime(startTimeStr), timeZone);
        const futureDates = dates
          .map(d => {
            return makeDateInTimeZone({
              year: Number(d.slice(0, 4)),
              month: Number(d.slice(5, 7)),
              day: Number(d.slice(8, 10)),
              hour: timeParts.hour,
              minute: timeParts.minute,
              second: 0
            }, timeZone);
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

    const currentStart = this.getCurrentSessionStart(startTimeStr, repeatMode, now, timeZone);
    if (currentStart > now) return currentStart;

    const stepDays = this.getRepeatStepDays(repeatMode);
    if (!stepDays) return nextStart;

    const currentParts = getZonedParts(currentStart, timeZone);
    return makeDateInTimeZone(addDaysToZonedParts(currentParts, stepDays), timeZone);
  }

  static getCurrentSessionStart(startTimeStr, repeatMode, now = new Date(), timeZone = 'Asia/Bangkok') {
    let currentStart = parseLocalDateTime(startTimeStr);
    if (isNaN(currentStart.getTime()) || currentStart > now) return currentStart;

    const dayMap = {
      'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
      'thursday': 4, 'friday': 5, 'saturday': 6
    };

    if (dayMap[repeatMode] !== undefined) {
      const targetDay = dayMap[repeatMode];
      let currentParts = getZonedParts(currentStart, timeZone);
      while (currentParts.weekday !== targetDay) {
        currentParts = addDaysToZonedParts(currentParts, 1);
        currentStart = makeDateInTimeZone(currentParts, timeZone);
      }

      while (true) {
        const nextStart = makeDateInTimeZone(addDaysToZonedParts(getZonedParts(currentStart, timeZone), 7), timeZone);
        if (nextStart > now) return currentStart;
        currentStart = nextStart;
      }
    }

    const stepDays = this.getRepeatStepDays(repeatMode);
    if (!stepDays) return currentStart;

    while (true) {
      const nextStart = makeDateInTimeZone(addDaysToZonedParts(getZonedParts(currentStart, timeZone), stepDays), timeZone);
      if (nextStart <= currentStart || nextStart > now) return currentStart;
      currentStart = nextStart;
    }
  }

  static getRepeatStepDays(repeatMode) {
    switch (repeatMode) {
      case 'daily': return 1;
      case 'weekly': return 7;
      case 'every_2_days': return 2;
      case 'every_3_days': return 3;
      case 'every_4_days': return 4;
      case 'every_5_days': return 5;
      case 'sunday':
      case 'monday':
      case 'tuesday':
      case 'wednesday':
      case 'thursday':
      case 'friday':
      case 'saturday':
        return 7;
      default:
        return 0;
    }
  }

  static isReadyToStart(status) {
    return !status || status === 'offline' || status === 'scheduled';
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
        schedule_time: this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, getSeriesTimeZone(series)).toISOString()
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
      
      // FIX #4: db.run is callback-based in sqlite3 — must wrap in Promise, not use await directly.
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO streams (id, user_id, title, video_id, rtmp_url, stream_key, platform, status, is_youtube_api, youtube_channel_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [streamId, series.user_id, series.name, sourceId, '', '', 'YouTube', 'scheduled', 1, series.youtube_channel_id],
          function(err) {
            if (err) {
              console.error('[Autolive] Error creating stream record:', err.message);
              return reject(err);
            }
            resolve();
          }
        );
      });
      stream = await Stream.findById(streamId);
    }
    return stream;
  }

  static async startAutoliveStream(series) {
    try {
      const streamId = `autolive_${series.id}`;
      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      
      // Ensure stream record exists
      let streamRecord = await this.getOrCreateStreamRecord(series);

      // Get current item metadata and update stream record BEFORE starting
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length > 0) {
        const currentItem = items[series.current_item_index % items.length];
        await Stream.update(streamRecord.id, {
          title: currentItem.title,
          youtube_description: currentItem.description || '',
          youtube_tags: currentItem.tags || '',
          youtube_thumbnail: currentItem.thumbnail_path || null,
          youtube_privacy: series.privacy || 'public',
          youtube_category: series.category_id || '10',
          youtube_monetization: series.monetization_enabled === 1 ? 1 : 0,
          made_for_kids: series.made_for_kids === 1 ? 1 : 0,
          youtube_playlist_id: series.playlist_id || null
        });
        console.log(`[Autolive] Stream record updated with item[${series.current_item_index}]: "${currentItem.title}"`);
      }

      const result = await streamingService.startStream(streamId, false, baseUrl);
      if (result.success) {
        await Autolive.update(series.id, { 
          status: 'live',
          last_metadata_update: new Date().toISOString()
        });
      } else {
        console.error(`[Autolive] Start failed for "${series.name}": ${result.error || 'Unknown error'}`);
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
