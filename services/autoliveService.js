const Autolive = require('../models/Autolive');
const Stream = require('../models/Stream');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
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

async function getAutoliveSourceSettings(target) {
  const sourceId = target.internal_playlist_id || target.video_id;
  if (!sourceId) {
    return {};
  }

  if (target.internal_playlist_id) {
    const playlist = await Playlist.findByIdWithVideos(target.internal_playlist_id);
    const firstVideo = playlist && playlist.videos && playlist.videos.find(video => video.resolution);
    return firstVideo
      ? {
          resolution: firstVideo.resolution,
          bitrate: firstVideo.bitrate || null,
          fps: firstVideo.fps || null
        }
      : {};
  }

  const video = await Video.findById(target.video_id);
  return video
    ? {
        resolution: video.resolution || null,
        bitrate: video.bitrate || null,
        fps: video.fps || null
      }
    : {};
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

    const timeZone = getSeriesTimeZone(series);
    console.log(`[Autolive] Processing "${series.name}": items=${items.length}, repeat=${series.repeat_mode}`);

    const durationMs = (series.duration || 60) * 60 * 1000;

    // Get the upcoming schedule (next 5 runs) to process and prepare
    const upcoming = this.getUpcomingSchedule(series, items, 5);

    for (const session of upcoming) {
      const targetStart = session.startTime;
      const targetEnd = session.endTime;
      const ts = targetStart.getTime();
      const streamId = `autolive_${series.id}_${ts}`;
      const linkedStream = await Stream.findById(streamId);

      const timeToTarget = targetStart - now;
      const isPastSession = now >= targetEnd;
      const isCurrentlyActive = now >= targetStart && now < targetEnd;

      // 1. If this session is currently active and the stream is not live yet, check/trigger scheduler to start it
      if (isCurrentlyActive && (!linkedStream || linkedStream.status === 'scheduled')) {
        // Sync metadata to create the scheduled broadcast on YouTube
        await this.syncToYouTube(series, targetStart, targetEnd);
        
        const schedulerService = require('./schedulerService');
        schedulerService.checkScheduledStreams().catch(err => {
          console.error('[Autolive] Error triggering stream scheduler:', err);
        });
      }

      // 2. Stop this session if it is live and duration reached
      if (linkedStream && linkedStream.status === 'live' && now >= targetEnd) {
        console.log(`[Autolive] Stopping live for series "${series.name}" session ${targetStart.toISOString()} (Duration reached)`);
        await this.stopAutoliveStream(series, targetStart);
      }

      // 3. Prepare future sessions 3 hours before start
      const shouldPrepare = !isPastSession && (timeToTarget <= PREPARE_WINDOW_MS || series.repeat_mode === 'nonstop');
      if (shouldPrepare) {
        const lastSync = series.last_metadata_update ? new Date(series.last_metadata_update).getTime() : 0;
        const shouldSync = !linkedStream || (now.getTime() - lastSync > 30 * 60 * 1000) || timeToTarget < 5 * 60 * 1000;
        
        if (shouldSync) {
          console.log(`[Autolive] Preparing session ${targetStart.toISOString()} for "${series.name}"...`);
          await this.syncToYouTube(series, targetStart, targetEnd);
          
          await Autolive.update(series.id, {
              last_metadata_update: now.toISOString()
          });
        }
      }
    }
  }

  static getNextStartTime(startTimeStrOrSeries, repeatMode, customDatesStr = null, timeZone = 'Asia/Bangkok', relativeTo = new Date()) {
    let series = null;
    let startTimeStr = startTimeStrOrSeries;
    let dailyTimes = null;

    if (startTimeStrOrSeries && typeof startTimeStrOrSeries === 'object') {
      series = startTimeStrOrSeries;
      startTimeStr = series.start_time;
      repeatMode = series.repeat_mode;
      timeZone = getSeriesTimeZone(series);
      dailyTimes = series.daily_times;
      customDatesStr = series.custom_dates;
    }

    if (!startTimeStr) return new Date(8640000000000000); // Far future
    let nextStart = parseLocalDateTime(startTimeStr);
    const now = relativeTo;

    // DAILY TIMES LOGIC
    if (repeatMode === 'daily' && dailyTimes) {
      const matches = [...dailyTimes.matchAll(/(\d{1,2})[.:, ]+(\d{2})/g)];
      const times = matches.map(m => {
        const hour = m[1].padStart(2, '0');
        const minute = m[2];
        return `${hour}:${minute}`;
      }).sort();
      if (times.length > 0) {
        const originalStart = parseLocalDateTime(startTimeStr);
        const zonedNowParts = getZonedParts(now, timeZone);
        const candidates = [];
        
        for (const dayOffset of [-1, 0, 1]) {
          const targetParts = addDaysToZonedParts(zonedNowParts, dayOffset);
          for (const timeStr of times) {
            const [hour, minute] = timeStr.split(':').map(Number);
            const candDate = makeDateInTimeZone({
              year: targetParts.year,
              month: targetParts.month,
              day: targetParts.day,
              hour,
              minute,
              second: 0
            }, timeZone);
            if (candDate >= originalStart) {
              candidates.push(candDate);
            }
          }
        }
        
        candidates.sort((a, b) => a - b);
        const futureCandidates = candidates.filter(c => c > now);
        if (futureCandidates.length > 0) return futureCandidates[0];
        
        // Fallback to tomorrow
        const tomorrowParts = addDaysToZonedParts(zonedNowParts, 1);
        const [hour, minute] = times[0].split(':').map(Number);
        return makeDateInTimeZone({
          year: tomorrowParts.year,
          month: tomorrowParts.month,
          day: tomorrowParts.day,
          hour,
          minute,
          second: 0
        }, timeZone);
      }
    }

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
    if (repeatMode === 'none' || repeatMode === 'nonstop' || !repeatMode) return nextStart;

    const currentStart = this.getCurrentSessionStart(startTimeStrOrSeries, repeatMode, now, timeZone);
    if (currentStart > now) return currentStart;

    const stepDays = this.getRepeatStepDays(repeatMode);
    if (!stepDays) return nextStart;

    const currentParts = getZonedParts(currentStart, timeZone);
    return makeDateInTimeZone(addDaysToZonedParts(currentParts, stepDays), timeZone);
  }

  static getCurrentSessionStart(startTimeStrOrSeries, repeatMode, now = new Date(), timeZone = 'Asia/Bangkok') {
    let series = null;
    let startTimeStr = startTimeStrOrSeries;
    let dailyTimes = null;

    if (startTimeStrOrSeries && typeof startTimeStrOrSeries === 'object') {
      series = startTimeStrOrSeries;
      startTimeStr = series.start_time;
      repeatMode = series.repeat_mode;
      timeZone = getSeriesTimeZone(series);
      dailyTimes = series.daily_times;
    }

    let currentStart = parseLocalDateTime(startTimeStr);
    if (isNaN(currentStart.getTime()) || currentStart > now) return currentStart;

    const durationMs = ((series && series.duration) || 60) * 60 * 1000;

    // DAILY TIMES LOGIC
    if (repeatMode === 'daily' && dailyTimes) {
      const matches = [...dailyTimes.matchAll(/(\d{1,2})[.:, ]+(\d{2})/g)];
      const times = matches.map(m => {
        const hour = m[1].padStart(2, '0');
        const minute = m[2];
        return `${hour}:${minute}`;
      }).sort();
      if (times.length > 0) {
        const originalStart = parseLocalDateTime(startTimeStr);
        const zonedNowParts = getZonedParts(now, timeZone);
        const candidates = [];
        
        for (const dayOffset of [-1, 0, 1]) {
          const targetParts = addDaysToZonedParts(zonedNowParts, dayOffset);
          for (const timeStr of times) {
            const [hour, minute] = timeStr.split(':').map(Number);
            const candDate = makeDateInTimeZone({
              year: targetParts.year,
              month: targetParts.month,
              day: targetParts.day,
              hour,
              minute,
              second: 0
            }, timeZone);
            if (candDate >= originalStart) {
              candidates.push(candDate);
            }
          }
        }
        
        candidates.sort((a, b) => a - b);
        const pastCandidates = candidates.filter(c => c <= now);
        
        const activeCandidates = pastCandidates.filter(c => c.getTime() + durationMs > now.getTime());
        if (activeCandidates.length > 0) {
          return activeCandidates[0]; // oldest active session
        }
        
        if (pastCandidates.length > 0) {
          return pastCandidates[pastCandidates.length - 1];
        }
        return candidates[0] || originalStart;
      }
    }

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

      const candidates = [currentStart];
      while (true) {
        const nextStart = makeDateInTimeZone(addDaysToZonedParts(getZonedParts(currentStart, timeZone), 7), timeZone);
        if (nextStart > now) break;
        candidates.push(nextStart);
        currentStart = nextStart;
      }

      const pastCandidates = candidates.filter(c => c <= now);
      const activeCandidates = pastCandidates.filter(c => c.getTime() + durationMs > now.getTime());
      if (activeCandidates.length > 0) {
        return activeCandidates[0];
      }
      return pastCandidates[pastCandidates.length - 1] || currentStart;
    }

    const stepDays = this.getRepeatStepDays(repeatMode);
    if (!stepDays) return currentStart;

    const candidates = [currentStart];
    while (true) {
      const nextStart = makeDateInTimeZone(addDaysToZonedParts(getZonedParts(currentStart, timeZone), stepDays), timeZone);
      if (nextStart <= currentStart || nextStart > now) break;
      candidates.push(nextStart);
      currentStart = nextStart;
    }

    const pastCandidates = candidates.filter(c => c <= now);
    const activeCandidates = pastCandidates.filter(c => c.getTime() + durationMs > now.getTime());
    if (activeCandidates.length > 0) {
      return activeCandidates[0];
    }
    return pastCandidates[pastCandidates.length - 1] || currentStart;
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
      let items = await Autolive.getItemsBySeriesId(series.id);
      
      // FIX: If no local items, try to fetch from YouTube Playlist
      if (items.length === 0 && series.playlist_id) {
          console.log(`[Autolive] No local items, fetching from YouTube Playlist: ${series.playlist_id}`);
          try {
              const ytItems = await youtubeService.getPlaylistItems(series.user_id, series.youtube_channel_id, series.playlist_id);
              items = ytItems.map((yt, idx) => ({
                  title: yt.title,
                  description: yt.description,
                  thumbnail_path: yt.thumbnail,
                  order_index: idx
              }));
          } catch (e) {
              console.error(`[Autolive] Failed to fetch YouTube playlist items:`, e.message);
          }
      }

      if (items.length === 0) return;

      const scheduledStart = targetStart || this.getNextStartTime(series, series.repeat_mode, series.custom_dates, getSeriesTimeZone(series));
      const scheduledEnd = targetEnd || new Date(scheduledStart.getTime() + ((series.duration || 60) * 60 * 1000));
      
      // Round-based rotation: determine which item and title to use
      const totalSessions = this.getTotalSessions(items);
      let globalIndex = series.current_item_index || 0;

      const upcoming = this.getUpcomingSchedule(series, items, 15);
      const matchingSession = upcoming.find(s => s.startTime.getTime() === scheduledStart.getTime());

      if (matchingSession) {
        globalIndex = matchingSession.globalIndex;
      }

      if (globalIndex >= totalSessions) {
        console.log(`[Autolive] Series "${series.name}" completed all ${totalSessions} sessions. Deactivating.`);
        await Autolive.update(series.id, { is_active: 0, status: 'offline' });
        return;
      }

      const { item: chosenSlot, titleIndex } = this.getItemForGlobalIndex(series, items, globalIndex);

      const isNewSessionCheck = await new Promise((resolve) => {
        const ts = scheduledStart.getTime();
        const streamId = `autolive_${series.id}_${ts}`;
        db.get('SELECT schedule_time FROM streams WHERE id = ?', [streamId], (err, row) => {
          resolve(!row);
        });
      });

      const chosenVideoId = chosenSlot.internal_playlist_id || chosenSlot.video_id || series.internal_playlist_id || series.video_id;

      let streamRecord = await this.getOrCreateStreamRecord(series, {
        title: series.name,
        schedule_time: scheduledStart.toISOString(),
        end_time: scheduledEnd.toISOString(),
        duration: series.duration || null,
        video_id: chosenVideoId
      });

      if (streamRecord.video_id !== chosenVideoId) {
        await Stream.update(streamRecord.id, { video_id: chosenVideoId });
        streamRecord.video_id = chosenVideoId;
      }

      const isNewSession = !streamRecord.schedule_time || (new Date(streamRecord.schedule_time).getTime() !== scheduledStart.getTime());

      if (isNewSession) {
        await Autolive.update(series.id, { current_item_index: chosenSlotIndex });
      }
      
      if (chosenSlot.internal_playlist_id) {
        if (isNewSession) {
          const { videoId } = await this.getNextRandomVideoData(series, chosenSlot.internal_playlist_id);
          await Autolive.update(series.id, { current_video_id: videoId });
        }
      }

      const titles = chosenSlot.titles || [];
      const thumbnails = chosenSlot.thumbnails || [];
      
      const title = titles[titleIndex % (titles.length || 1)] || series.name;
      const thumbnail = thumbnails[titleIndex % (thumbnails.length || 1)] || '';

      const sourceSettings = await getAutoliveSourceSettings(chosenSlot);
      const sourceRes = sourceSettings.resolution || null;
      const dbRes = streamRecord.resolution || null;
      
      if (
        streamRecord.status === 'scheduled' &&
        streamRecord.youtube_stream_id &&
        sourceRes && 
        dbRes && 
        dbRes !== sourceRes
      ) {
        console.log(`[Autolive] Source resolution changed for ${streamRecord.id}: ${dbRes} -> ${sourceRes}. Recreating scheduled YouTube broadcast.`);
        await youtubeService.deleteYouTubeBroadcast(streamRecord.id);
        streamRecord = await Stream.findById(streamRecord.id);
      }
      
      // Update stream record with current item metadata and series settings
      console.log(`[Autolive] Updating stream metadata for ${streamRecord.id}. Thumbnail: ${thumbnail}`);
      
      const nextVideoId = chosenSlot.internal_playlist_id || chosenSlot.video_id;

      await Stream.update(streamRecord.id, {
        title: title,
        video_id: nextVideoId,
        youtube_description: chosenSlot.description || '',
        youtube_tags: chosenSlot.tags || '',
        youtube_thumbnail: thumbnail,
        schedule_time: scheduledStart.toISOString(),
        resolution: sourceRes || dbRes || null,
        bitrate: sourceSettings.bitrate || streamRecord.bitrate || 2500,
        fps: sourceSettings.fps || streamRecord.fps || 30,
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
    const ts = defaults.schedule_time ? new Date(defaults.schedule_time).getTime() : new Date(series.start_time).getTime();
    const streamId = `autolive_${series.id}_${ts}`;
    let stream = await Stream.findById(streamId);
    if (!stream) {
      const items = await Autolive.getItemsBySeriesId(series.id);
      let sourceId = defaults.video_id || series.internal_playlist_id || series.video_id;
      if (!defaults.video_id && items.length > 0) {
        sourceId = items[0].internal_playlist_id || items[0].video_id || sourceId;
      }
      
      // FIX #4: db.run is callback-based in sqlite3 — must wrap in Promise, not use await directly.
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO streams (
            id, user_id, title, video_id, rtmp_url, stream_key, platform, status,
            is_youtube_api, youtube_channel_id, schedule_time, end_time, duration,
            resolution, bitrate, fps
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            defaults.duration || null,
            defaults.resolution || null,
            defaults.bitrate || 2500,
            defaults.fps || 30
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
      const sourceSettings = await getAutoliveSourceSettings(series);
      let streamRecord = await this.getOrCreateStreamRecord(series, sourceSettings);

      // Get current item metadata and update stream record BEFORE starting
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length > 0) {
        const { item: currentItem, titleIndex } = this.getItemForGlobalIndex(series, items, series.current_item_index || 0);
        const itemTitles = Array.isArray(currentItem.titles) ? currentItem.titles : [];
        const itemThumbnails = Array.isArray(currentItem.thumbnails) ? currentItem.thumbnails : [];
        const currentTitle = itemTitles[titleIndex % (itemTitles.length || 1)] || currentItem.title || series.name;
        const currentThumbnail = itemThumbnails[titleIndex % (itemThumbnails.length || 1)] || currentItem.thumbnail_path || '';
        
        console.log(`[Autolive] Starting stream ${streamRecord.id} with round-based metadata. Title: ${currentTitle}`);
        await Stream.update(streamRecord.id, {
          title: currentTitle,
          youtube_description: currentItem.description || '',
          youtube_tags: currentItem.tags || '',
          youtube_thumbnail: currentThumbnail,
          resolution: sourceSettings.resolution || streamRecord.resolution || null,
          bitrate: sourceSettings.bitrate || streamRecord.bitrate || 2500,
          fps: sourceSettings.fps || streamRecord.fps || 30,
          youtube_privacy: series.privacy || 'public',
          youtube_category: series.category_id || '10',
          youtube_monetization: series.monetization_enabled === 1 ? 1 : 0,
          made_for_kids: series.made_for_kids === 1 ? 1 : 0,
          youtube_playlist_id: series.playlist_id || null
        });
        console.log(`[Autolive] Stream record updated with globalIndex[${series.current_item_index}]: "${currentTitle}"`);
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

  static async stopAutoliveStream(series, targetStart = null) {
    try {
      let streamId = `autolive_${series.id}`;
      if (targetStart) {
        const ts = new Date(targetStart).getTime();
        streamId = `autolive_${series.id}_${ts}`;
      } else {
        // Query database to find the active live stream for this series
        const activeLiveId = await new Promise((resolve) => {
          db.get("SELECT id FROM streams WHERE id LIKE ? AND status = 'live'", [`autolive_${series.id}%`], (err, row) => {
            resolve(row ? row.id : null);
          });
        });
        if (activeLiveId) {
          streamId = activeLiveId;
        } else {
          const items = await Autolive.getItemsBySeriesId(series.id);
          const upcoming = this.getUpcomingSchedule(series, items, 1);
          if (upcoming.length > 0) {
            const ts = new Date(upcoming[0].startTime).getTime();
            streamId = `autolive_${series.id}_${ts}`;
          }
        }
      }

      await streamingService.stopStream(streamId, {
        reason: 'scheduled_end',
        message: 'Autolive berhenti karena durasi atau jadwal item sudah selesai.'
      });
      
      const newIndex = (series.current_item_index || 0) + 1;
      const stopItems = await Autolive.getItemsBySeriesId(series.id);
      const totalSessions = this.getTotalSessions(stopItems);

      const updateData = { 
        status: 'offline',
        youtube_broadcast_id: null,
        youtube_stream_id: null,
        current_item_index: newIndex
      };

      // If all sessions are done, deactivate the series
      if (newIndex >= totalSessions) {
        updateData.is_active = 0;
        console.log(`[Autolive] Series "${series.name}" completed all ${totalSessions} sessions. Deactivated.`);
      }

      await Autolive.update(series.id, updateData);
    } catch (error) {
      console.error(`[Autolive] Stop failed for "${series.name}":`, error);
    }
  }

  static async swapMetadataMidStream(series) {
    try {
      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length <= 1) return;

      const nextGlobalIndex = (series.current_item_index || 0) + 1;
      const totalSessions = this.getTotalSessions(items);
      if (nextGlobalIndex >= totalSessions) return; // No more sessions

      const { item: nextItem, titleIndex: nextTitleIndex } = this.getItemForGlobalIndex(series, items, nextGlobalIndex);
      const nextTitles = Array.isArray(nextItem.titles) ? nextItem.titles : [];
      const nextThumbnails = Array.isArray(nextItem.thumbnails) ? nextItem.thumbnails : [];
      const swapTitle = nextTitles[nextTitleIndex % (nextTitles.length || 1)] || nextItem.title || series.name;
      const swapThumbnail = nextThumbnails[nextTitleIndex % (nextThumbnails.length || 1)] || nextItem.thumbnail_path || '';
      
      // Find currently live stream ID
      const streamId = await new Promise((resolve) => {
        db.get("SELECT id FROM streams WHERE id LIKE ? AND status = 'live'", [`autolive_${series.id}%`], (err, row) => {
          resolve(row ? row.id : null);
        });
      }) || `autolive_${series.id}`;

      const stream = await Stream.findById(streamId);

      if (!stream || !stream.youtube_broadcast_id) return;

      console.log(`[Autolive] Swapping to next metadata (globalIndex ${nextGlobalIndex}): ${swapTitle}`);
      
      // Update YouTube via Service
      const user = await require('../models/User').findById(series.user_id);
      const YoutubeChannel = require('../models/YoutubeChannel');
      const channel = await YoutubeChannel.findById(series.youtube_channel_id);
      
      if (user && channel) {
        await youtubeService.updateLiveMetadata(series.user_id, series.youtube_channel_id, stream.youtube_broadcast_id, {
          title: swapTitle,
          description: nextItem.description || '',
          thumbnail_path: swapThumbnail
        });

        const Stream = require('../models/Stream');
        await Stream.update(streamId, {
          title: swapTitle,
          youtube_description: nextItem.description || '',
          youtube_thumbnail: swapThumbnail
        });

        await Autolive.update(series.id, {
          current_item_index: nextGlobalIndex,
          last_metadata_update: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[Autolive] Mid-stream swap failed for "${series.name}":`, error);
    }
  }

  static async syncCurrentMetadataNow(seriesId) {
    try {
      const series = await Autolive.findById(seriesId);
      if (!series) return { success: false, error: 'Series not found' };

      const items = await Autolive.getItemsBySeriesId(series.id);
      if (items.length === 0) return { success: false, error: 'No metadata items' };

      const streamId = await new Promise((resolve) => {
        db.get("SELECT id FROM streams WHERE id LIKE ? AND (status = 'live' OR status = 'scheduled') ORDER BY schedule_time ASC LIMIT 1", [`autolive_${series.id}%`], (err, row) => {
          resolve(row ? row.id : null);
        });
      }) || `autolive_${series.id}`;

      const stream = await Stream.findById(streamId);

      if (!stream) {
        return { success: true, skipped: true, message: 'Linked stream task has not been created yet' };
      }

      // Determine the correct item matching this stream's scheduled start (round-based)
      const upcoming = this.getUpcomingSchedule(series, items, 15);
      const streamStart = stream.schedule_time ? new Date(stream.schedule_time) : new Date(series.start_time);
      const matchingSession = upcoming.find(s => s.startTime.getTime() === streamStart.getTime());
      
      let globalIndex = series.current_item_index || 0;
      if (matchingSession) {
        globalIndex = matchingSession.globalIndex;
      }

      const { item: currentItem, titleIndex } = this.getItemForGlobalIndex(series, items, globalIndex);
      const syncTitles = Array.isArray(currentItem.titles) ? currentItem.titles : [];
      const syncThumbnails = Array.isArray(currentItem.thumbnails) ? currentItem.thumbnails : [];
      const currentTitle = syncTitles[titleIndex % (syncTitles.length || 1)] || currentItem.title || series.name;
      const currentThumbnail = syncThumbnails[titleIndex % (syncThumbnails.length || 1)] || currentItem.thumbnail_path || '';

      const sourceSettings = await getAutoliveSourceSettings(currentItem);
      await Stream.update(streamId, {
        title: currentTitle,
        video_id: currentItem.internal_playlist_id || currentItem.video_id || series.internal_playlist_id || series.video_id,
        youtube_description: currentItem.description || '',
        youtube_tags: currentItem.tags || '',
        youtube_thumbnail: currentThumbnail,
        resolution: sourceSettings.resolution || stream.resolution || null,
        bitrate: sourceSettings.bitrate || stream.bitrate || 2500,
        fps: sourceSettings.fps || stream.fps || 30,
        youtube_privacy: series.privacy || 'public',
        youtube_category: series.category_id || '10',
        youtube_monetization: series.monetization_enabled === 1 ? 1 : 0,
        made_for_kids: series.made_for_kids === 1 ? 1 : 0,
        youtube_playlist_id: series.playlist_id || null
      });

      if (stream.youtube_broadcast_id) {
        await youtubeService.updateLiveMetadata(series.user_id, series.youtube_channel_id, stream.youtube_broadcast_id, {
          title: currentTitle,
          description: currentItem.description || '',
          tags: currentItem.tags || '',
          category: series.category_id || '10',
          thumbnail_path: currentThumbnail
        });
      }

      return { success: true };
    } catch (error) {
      console.error(`[Autolive] Immediate metadata sync failed for series ${seriesId}:`, error);
      return { success: false, error: error.message };
    }
  }

  // === Round-based rotation helpers ===
  
  static getTotalSessions(items) {
    if (!items || items.length === 0) return 0;
    const maxTitles = Math.max(...items.map(it => {
      const titles = Array.isArray(it.titles) ? it.titles : [];
      return titles.length || 1;
    }));
    return items.length * maxTitles;
  }

  static getFullOrderForRound(seriesId, roundNumber, itemCount) {
    if (itemCount <= 1) return [0];
    
    // Round 0: sequential order
    if (roundNumber === 0) {
      return Array.from({ length: itemCount }, (_, i) => i);
    }
    
    // Round 1+: seeded shuffle
    let order = seededShuffle(
      Array.from({ length: itemCount }, (_, i) => i),
      hashCode(seriesId + '_round_' + roundNumber)
    );
    
    // Anti-consecutive: ensure first of this round != last of previous round
    const prevOrder = this.getFullOrderForRound(seriesId, roundNumber - 1, itemCount);
    const lastOfPrev = prevOrder[itemCount - 1];
    
    if (order[0] === lastOfPrev) {
      for (let swapIdx = 1; swapIdx < order.length; swapIdx++) {
        if (order[swapIdx] !== lastOfPrev) {
          [order[0], order[swapIdx]] = [order[swapIdx], order[0]];
          break;
        }
      }
    }
    
    return order;
  }

  static getItemForGlobalIndex(series, items, globalIndex) {
    const itemCount = items.length;
    if (itemCount === 0) return { item: null, titleIndex: 0, roundNumber: 0, positionInRound: 0 };
    
    const roundNumber = Math.floor(globalIndex / itemCount);
    const positionInRound = globalIndex % itemCount;
    const titleIndex = roundNumber;
    
    const order = this.getFullOrderForRound(series.id, roundNumber, itemCount);
    const videoIndex = order[positionInRound];
    
    return {
      item: items[videoIndex],
      titleIndex,
      roundNumber,
      positionInRound,
      videoOrderIndex: videoIndex
    };
  }

  static getUpcomingSchedule(series, items, count = 5) {
    if (!items || items.length === 0) return [];
    
    const schedule = [];
    const timeZone = getSeriesTimeZone(series);
    const durationMs = (series.duration || 60) * 60 * 1000;
    const now = new Date();
    const totalSessions = this.getTotalSessions(items);
    
    let currentStart = this.getCurrentSessionStart(series, series.repeat_mode, now, timeZone);
    let globalIndex = series.current_item_index || 0;
    
    // If the current session is already in the past (finished), move to next
    if (new Date(currentStart.getTime() + durationMs) < now) {
      currentStart = this.getNextStartTime(series, series.repeat_mode, series.custom_dates, timeZone);
    }
    
    for (let i = 0; i < count; i++) {
      // Stop if all sessions exhausted
      if (globalIndex >= totalSessions) break;
      
      const { item, titleIndex, positionInRound } = this.getItemForGlobalIndex(series, items, globalIndex);
      if (!item) break;
      
      const titles = Array.isArray(item.titles) ? item.titles : [];
      const thumbnails = Array.isArray(item.thumbnails) ? item.thumbnails : [];
      
      const title = titles[titleIndex % (titles.length || 1)] || series.name;
      const thumbnail = thumbnails[titleIndex % (thumbnails.length || 1)] || '';

      schedule.push({
        startTime: new Date(currentStart),
        endTime: new Date(currentStart.getTime() + durationMs),
        title: title,
        thumbnail: thumbnail,
        index: positionInRound + 1,
        globalIndex: globalIndex,
        titleIndex: titleIndex
      });
      
      // Calculate next start
      const stepDays = this.getRepeatStepDays(series.repeat_mode);
      if (series.repeat_mode === 'none' || !stepDays) {
        if (series.repeat_mode === 'custom' && series.custom_dates) {
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
        if (series.repeat_mode === 'daily' && series.daily_times) {
            const nextRelativeTo = new Date(currentStart.getTime() + 1000);
            currentStart = this.getNextStartTime(series, series.repeat_mode, null, timeZone, nextRelativeTo);
        } else {
            const currentParts = getZonedParts(currentStart, timeZone);
            currentStart = makeDateInTimeZone(addDaysToZonedParts(currentParts, stepDays), timeZone);
        }
      }
      globalIndex++;
    }
    
    return schedule;
  }

  static async getNextRandomVideoData(series, playlistId) {
    try {
      const Playlist = require('../models/Playlist');
      const playlist = await Playlist.findByIdWithVideos(playlistId);
      if (!playlist || !playlist.videos || playlist.videos.length === 0) {
        return { videoId: null, itemIndex: 0 };
      }
      
      let pool = [];
      try {
        pool = JSON.parse(series.random_pool_state || '[]');
      } catch (e) {
        pool = [];
      }
      
      const maxIndex = playlist.videos.length - 1;
      pool = pool.filter(idx => typeof idx === 'number' && idx >= 0 && idx <= maxIndex);
      
      if (pool.length === 0) {
        const indices = Array.from({ length: playlist.videos.length }, (_, i) => i);
        pool = shuffleArray(indices);
      }
      
      const chosenIndex = pool.shift();
      const videoId = playlist.videos[chosenIndex].id;
      
      const Autolive = require('../models/Autolive');
      await Autolive.update(series.id, {
        random_pool_state: JSON.stringify(pool)
      });
      
      console.log(`[Autolive] Selected random video index ${chosenIndex} (Video ID: ${videoId}) from playlist ${playlistId}. Remaining pool size: ${pool.length}`);
      return { videoId, itemIndex: chosenIndex };
    } catch (err) {
      console.error('[Autolive] Error selecting next random video data:', err);
      return { videoId: null, itemIndex: 0 };
    }
  }

  static async getNextRandomSlot(series, items) {
    try {
      let pool = [];
      try {
        pool = JSON.parse(series.random_pool_state || '[]');
      } catch (e) {
        pool = [];
      }
      
      const itemIds = items.map(it => it.id);
      pool = pool.filter(id => itemIds.includes(id));
      
      if (pool.length === 0) {
        pool = shuffleArray([...itemIds]);
      }
      
      const chosenSlotId = pool.shift();
      const Autolive = require('../models/Autolive');
      await Autolive.update(series.id, {
        random_pool_state: JSON.stringify(pool)
      });
      
      console.log(`[Autolive] Selected random slot ${chosenSlotId}. Remaining pool size: ${pool.length}`);
      return items.find(it => it.id === chosenSlotId) || items[0];
    } catch (err) {
      console.error('[Autolive] Error selecting next random slot:', err);
      return items[0];
    }
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash) || 1;
}

function seededShuffle(array, seed) {
  const result = [...array];
  let s = seed || 1;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = AutoliveService;
