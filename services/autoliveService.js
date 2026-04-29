const Autolive = require('../models/Autolive');
const Stream = require('../models/Stream');
const youtubeService = require('./youtubeService');
const streamingService = require('./streamingService');
const { db } = require('../db/database');
const path = require('path');
const fs = require('fs');

let checkInterval = null;
const PREPARE_WINDOW_MS = 3 * 60 * 60 * 1000;

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

    // Looping is handled by % items.length in syncToYouTube, so we don't need to force stop here
    // unless it's a one-time series that has no more sessions (which is handled below).


    const timeZone = getSeriesTimeZone(series);
    console.log(`[Autolive] Processing "${series.name}": index=${series.current_item_index}, items=${items.length}, repeat=${series.repeat_mode}`);


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
    const streamId = `autolive_${series.id}`;
    const linkedStream = await Stream.findById(streamId);

    if (linkedStream && linkedStream.status === 'live' && series.status !== 'live') {
      await Autolive.update(series.id, {
        status: 'live',
        last_metadata_update: series.last_metadata_update || new Date().toISOString()
      });
      series.status = 'live';
    }

    // 1. Stop Live
    if (series.status === 'live' && now >= sessionEnd) {
      console.log(`[Autolive] Stopping live for series "${series.name}" (Duration reached)`);
      await this.stopAutoliveStream(series);
      return;
    }

    // 2. Prepare the next/current stream task in the Stream tab 3 hours before start.
    const futureStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, timeZone);
    const targetStart = now < sessionEnd ? sessionStart : futureStart;
    const targetEnd = new Date(targetStart.getTime() + durationMs);
    const timeToTarget = targetStart - now;
    const alreadyQueued = this.isStreamQueuedFor(linkedStream, targetStart);

    if (isReadyToStart && now < targetEnd && timeToTarget <= PREPARE_WINDOW_MS) {
      if (linkedStream && linkedStream.status === 'scheduled' && !linkedStream.schedule_time) {
        console.log(`[Autolive] Repairing missing schedule_time for "${series.name}" at ${targetStart.toISOString()}`);
        await Stream.update(streamId, {
          schedule_time: targetStart.toISOString(),
          end_time: targetEnd.toISOString(),
          duration: series.duration || null
        });
      }

      if (isReadyToStart && now < targetEnd && timeToTarget <= PREPARE_WINDOW_MS) {
        // ALWAYS update metadata for the linked stream to ensure it matches the current Autolive item
        // even if it was already queued before. This fixes the issue where thumbnail changes
        // in Autolive items don't reflect in the scheduled stream tasks.
        console.log(`[Autolive] Synchronizing metadata for "${series.name}"...`);
        await this.syncToYouTube(series, targetStart, targetEnd);

        if (now >= targetStart) {
          const schedulerService = require('./schedulerService');
          schedulerService.checkScheduledStreams().catch(err => {
            console.error('[Autolive] Error triggering stream scheduler:', err);
          });
        }
      }
    }

    // 3. Mid-Stream Auto-Swap (24 Hours+)
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

  static isStreamQueuedFor(stream, targetStart) {
    if (!stream || stream.status !== 'scheduled' || !stream.schedule_time) return false;
    const scheduledAt = new Date(stream.schedule_time);
    if (Math.abs(scheduledAt - targetStart) > 1000) return false;
    return !!(stream.youtube_broadcast_id && stream.youtube_stream_id && stream.rtmp_url && stream.stream_key);
  }

  static async syncToYouTube(series, targetStart = null, targetEnd = null) {
    try {
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length === 0) return;

      const currentItem = items[series.current_item_index % items.length];
      const scheduledStart = targetStart || this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, getSeriesTimeZone(series));
      const scheduledEnd = targetEnd || new Date(scheduledStart.getTime() + ((series.duration || 60) * 60 * 1000));
      
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
        schedule_time: scheduledStart.toISOString()
      };

      // We need to temporarily save this dummy stream to the DB so youtubeService can find it
      // OR we modify youtubeService to accept an object. 
      // Let's use a more robust way: create/update a dedicated stream record for this series.
      let streamRecord = await this.getOrCreateStreamRecord(series, {
        title: currentItem.title,
        schedule_time: scheduledStart.toISOString(),
        end_time: scheduledEnd.toISOString(),
        duration: series.duration || null
      });
      
      // Update stream record with current item metadata and series settings
      console.log(`[Autolive] Updating stream metadata for ${streamRecord.id}. Thumbnail: ${currentItem.thumbnail_path}`);
      await Stream.update(streamRecord.id, {
        title: currentItem.title,
        video_id: series.internal_playlist_id || series.video_id,
        youtube_description: currentItem.description || '',
        youtube_tags: currentItem.tags || '',
        youtube_thumbnail: currentItem.thumbnail_path || '',
        schedule_time: scheduledStart.toISOString(),
        youtube_privacy: series.privacy || 'public',
        youtube_category: series.category_id || '24',
        youtube_monetization: series.monetization_enabled === 1 ? 1 : 0,
        made_for_kids: series.made_for_kids === 1 ? 1 : 0,
        youtube_playlist_id: series.playlist_id || null,
        schedule_time: scheduledStart.toISOString(),
        end_time: scheduledEnd.toISOString(),
        duration: series.duration || null,
        status: streamRecord.status === 'live' ? 'live' : 'scheduled'
      });

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await youtubeService.createYouTubeBroadcast(streamRecord.id, baseUrl);
      
      if (result) {
        const updatedStream = await Stream.findById(streamRecord.id);
        await Autolive.update(series.id, {
          youtube_broadcast_id: updatedStream.youtube_broadcast_id,
          youtube_stream_id: updatedStream.youtube_stream_id,
          rtmp_url: updatedStream.rtmp_url,
          stream_key: updatedStream.stream_key,
          status: updatedStream.status === 'live' ? 'live' : 'scheduled'
        });
      }
    } catch (error) {
      console.error(`[Autolive] Sync failed for "${series.name}":`, error);
    }
  }

  static async getOrCreateStreamRecord(series, defaults = {}) {
    const streamId = `autolive_${series.id}`;
    let stream = await Stream.findById(streamId);
    if (!stream) {
      // For Autolive, we can use the video_id field in the streams table for both single video or playlist,
      // as the streamingService handles it based on ID lookup in videos or playlists table.
      const sourceId = series.internal_playlist_id || series.video_id;
      
      // FIX #4: db.run is callback-based in sqlite3 — must wrap in Promise, not use await directly.
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO streams (
            id, user_id, title, video_id, rtmp_url, stream_key, platform, status,
            is_youtube_api, youtube_channel_id, schedule_time, end_time, duration
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            streamId,
            series.user_id,
            defaults.title || series.name,
            sourceId,
            '',
            '',
            'YouTube',
            defaults.schedule_time ? 'scheduled' : 'offline',
            1,
            series.youtube_channel_id,
            defaults.schedule_time || null,
            defaults.end_time || null,
            defaults.duration || null
          ],
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
        console.log(`[Autolive] Starting stream ${streamRecord.id} with metadata. Thumbnail: ${currentItem.thumbnail_path}`);
        await Stream.update(streamRecord.id, {
          title: currentItem.title,
          youtube_description: currentItem.description || '',
          youtube_tags: currentItem.tags || '',
          youtube_thumbnail: currentItem.thumbnail_path || '',
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
        await youtubeService.updateLiveMetadata(series.user_id, series.youtube_channel_id, stream.youtube_broadcast_id, {
          title: nextItem.title,
          description: nextItem.description || '',
          thumbnail_path: nextItem.thumbnail_path
        });

        // FIX: Also update the local streams record so the UI reflects the change
        const Stream = require('../models/Stream');
        await Stream.update(streamId, {
          title: nextItem.title,
          youtube_description: nextItem.description || '',
          youtube_thumbnail: nextItem.thumbnail_path
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
  static getUpcomingSchedule(series, items, count = 5) {
    if (!items || items.length === 0) return [];
    
    const schedule = [];
    const timeZone = getSeriesTimeZone(series);
    const durationMs = (series.duration || 60) * 60 * 1000;
    const now = new Date();
    
    let currentStart = this.getCurrentSessionStart(series.start_time, series.repeat_mode, now, timeZone);
    let itemIndex = series.current_item_index || 0;
    
    // If the current session is already in the past (finished), move to next
    if (new Date(currentStart.getTime() + durationMs) < now) {
      currentStart = this.getNextStartTime(series.start_time, series.repeat_mode, series.custom_dates, timeZone);
      // itemIndex remains the same because it only increments after a successful stop
    }
    
    for (let i = 0; i < count; i++) {
      const item = items[itemIndex % items.length];
      schedule.push({
        startTime: new Date(currentStart),
        endTime: new Date(currentStart.getTime() + durationMs),
        title: item.title,
        thumbnail: item.thumbnail_path,
        index: (itemIndex % items.length) + 1
      });
      
      // Calculate next start
      const stepDays = this.getRepeatStepDays(series.repeat_mode);
      if (series.repeat_mode === 'none' || !stepDays) {
        if (series.repeat_mode === 'custom' && series.custom_dates) {
             // For custom dates, we'd need to find the next date in the list
             // This is a bit complex for a simple helper, so we'll just stop after 1 or do a simple search
             try {
                 const dates = JSON.parse(series.custom_dates);
                 const timeParts = getZonedParts(parseLocalDateTime(series.start_time), timeZone);
                 const sortedDates = dates
                     .map(d => makeDateInTimeZone({
                         year: Number(d.slice(0, 4)),
                         month: Number(d.slice(5, 7)),
                         day: Number(d.slice(8, 10)),
                         hour: timeParts.hour,
                         minute: timeParts.minute,
                         second: 0
                     }, timeZone))
                     .sort((a, b) => a - b);
                 
                 const currentIndex = sortedDates.findIndex(d => d.getTime() === currentStart.getTime());
                 if (currentIndex !== -1 && currentIndex + 1 < sortedDates.length) {
                     currentStart = sortedDates[currentIndex + 1];
                 } else {
                     break; // No more dates
                 }
             } catch(e) { break; }
        } else {
            break; 
        }
      } else {
        const currentParts = getZonedParts(currentStart, timeZone);
        currentStart = makeDateInTimeZone(addDaysToZonedParts(currentParts, stepDays), timeZone);
      }
      itemIndex++;
    }
    
    return schedule;
  }
}

module.exports = AutoliveService;
