const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const LoopTask = require('../models/LoopTask');
const Video = require('../models/Video');
const youtubeService = require('./youtubeService');
const { paths } = require('../utils/storage');

let ffmpegPath = '/usr/bin/ffmpeg';
if (!fs.existsSync(ffmpegPath)) {
  ffmpegPath = ffmpegInstaller.path;
}

let ffprobePath = '/usr/bin/ffprobe';
if (!fs.existsSync(ffprobePath)) {
  ffprobePath = ffprobeInstaller.path;
}

class VideoLoopService {
  constructor() {
    this.activeTasks = new Map();
  }

  async startTask(taskId) {
    const task = await LoopTask.findById(taskId);
    if (!task) return;

    try {
      await LoopTask.update(taskId, { status: 'rendering', progress: 0 });
      
      const projectRoot = path.resolve(__dirname, '..');
      const tempDir = path.join(projectRoot, 'temp', 'loop', taskId);
      await fs.ensureDir(tempDir);

      const video = await Video.findById(task.video_id);
      const audioIds = task.audio_ids.split(',').filter(id => id);
      const audioFiles = [];
      for (const id of audioIds) {
        const a = await Video.findById(id);
        if (a) audioFiles.push(path.join(projectRoot, 'public', a.filepath));
      }

      if (!video || audioFiles.length === 0) {
        throw new Error('Video or Audio files not found');
      }

      const visualPath = path.join(projectRoot, 'public', video.filepath);
      const isImage = (await this.isImageFile(visualPath));
      
      // 1. Get total audio duration
      const totalAudioDuration = await this.getTotalDuration(audioFiles);
      console.log(`[VideoLoopService] Total audio duration: ${totalAudioDuration}s`);

      // 2. Prepare visual loop
      let finalVisualPath = visualPath;
      let visualArgs = [];
      
      const outputVideoPath = path.join(tempDir, `rendered_${taskId}.mp4`);

      // 3. Render command
      // We use a complex filter to loop and merge
      // To avoid re-encoding the video as much as possible:
      // - If it's a video, we use concat demuxer to repeat it
      // - If it's an image, we encode it once
      
      let ffmpegArgs = [];

      if (isImage) {
        // For Image: loop the image to duration
        ffmpegArgs = [
          '-loop', '1',
          '-i', visualPath,
        ];
        // Add all audio inputs
        for (const af of audioFiles) {
          ffmpegArgs.push('-i', af);
        }

        // Complex filter to concat audios
        let filterAudio = '';
        for (let i = 0; i < audioFiles.length; i++) {
          filterAudio += `[${i + 1}:a]`;
        }
        filterAudio += `concat=n=${audioFiles.length}:v=0:a=1[aout]`;

        ffmpegArgs.push(
          '-filter_complex', filterAudio,
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'stillimage',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          '-t', totalAudioDuration.toString(),
          outputVideoPath
        );
      } else {
        // For Video: Use concat demuxer if "no re-encode" is strictly desired
        // But merging different audio files into a video loop usually needs a filter_complex
        // To strictly "not re-encode" video, we repeat the video segments in a concat file
        
        const videoDuration = await this.getDuration(visualPath);
        const repeatCount = Math.ceil(totalAudioDuration / videoDuration);
        
        const concatFilePath = path.join(tempDir, 'concat_video.txt');
        let concatContent = '';
        for (let i = 0; i < repeatCount; i++) {
          concatContent += `file '${visualPath.replace(/\\/g, '/')}'\n`;
        }
        await fs.writeFile(concatFilePath, concatContent);

        // First, merge audios into one temp file (lightweight)
        const mergedAudioPath = path.join(tempDir, 'merged_audio.m4a');
        await this.mergeAudios(audioFiles, mergedAudioPath);

        // Now, combine looped video with merged audio
        // Using -c:v copy to keep user request of "jangan reencode"
        ffmpegArgs = [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFilePath,
          '-i', mergedAudioPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-shortest',
          '-t', totalAudioDuration.toString(),
          outputVideoPath
        ];
      }

      // Priority Management: nice and ionice (only works on Linux)
      let finalCommand = ffmpegPath;
      let finalArgs = ffmpegArgs;
      
      if (process.platform === 'linux') {
        const hasNice = await this.commandExists('nice');
        const hasIonice = await this.commandExists('ionice');
        
        if (hasNice || hasIonice) {
          finalCommand = 'nice';
          finalArgs = ['-n', '19'];
          if (hasIonice) {
            finalArgs.push('ionice', '-c', '3');
          }
          finalArgs.push(ffmpegPath, ...ffmpegArgs);
        }
      }

      console.log(`[VideoLoopService] Running command: ${finalCommand} ${finalArgs.join(' ')}`);

      const proc = spawn(finalCommand, finalArgs);
      this.activeTasks.set(taskId, proc);

      proc.stderr.on('data', (data) => {
        const line = data.toString();
        const durationMatch = line.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
        if (durationMatch) {
          const currentTime = this.timeToSeconds(durationMatch[1]);
          const progress = Math.min(99, Math.round((currentTime / totalAudioDuration) * 100));
          LoopTask.update(taskId, { progress });
        }
      });

      proc.on('close', async (code) => {
        this.activeTasks.delete(taskId);
        if (code === 0) {
          await LoopTask.update(taskId, { progress: 100, status: 'uploading' });
          this.uploadTask(taskId, outputVideoPath, tempDir);
        } else {
          console.error(`[VideoLoopService] Task ${taskId} failed with code ${code}`);
          await LoopTask.update(taskId, { status: 'failed', error_message: `FFmpeg failed with code ${code}` });
          await fs.remove(tempDir).catch(() => {});
        }
      });

    } catch (error) {
      console.error(`[VideoLoopService] Error in task ${taskId}:`, error);
      await LoopTask.update(taskId, { status: 'failed', error_message: error.message });
    }
  }

  async uploadTask(taskId, videoPath, tempDir) {
    try {
      const task = await LoopTask.findById(taskId);
      if (!task) return;

      const metadata = {
        title: task.title,
        description: task.description,
        tags: task.tags,
        category: task.category,
        privacy: task.privacy,
        onProgress: (p) => {
          LoopTask.update(taskId, { progress: p });
        }
      };

      const result = await youtubeService.uploadVideoToYoutube(
        task.user_id,
        task.youtube_channel_id,
        videoPath,
        metadata
      );

      if (result.success) {
        await LoopTask.update(taskId, {
          status: 'completed',
          progress: 100,
          youtube_video_id: result.videoId
        });
      } else {
        throw new Error('YouTube upload failed');
      }
    } catch (error) {
      console.error(`[VideoLoopService] Upload error for task ${taskId}:`, error);
      await LoopTask.update(taskId, { status: 'failed', error_message: `Upload failed: ${error.message}` });
    } finally {
      // Cleanup
      await fs.remove(tempDir).catch(() => {});
    }
  }

  async isImageFile(filepath) {
    return new Promise((resolve) => {
      const ffprobe = spawn(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filepath
      ]);
      let output = '';
      ffprobe.stdout.on('data', (data) => output += data.toString().trim());
      ffprobe.on('close', () => {
        const imageCodecs = ['png', 'mjpeg', 'webp', 'bmp', 'tiff'];
        resolve(imageCodecs.includes(output.toLowerCase()));
      });
    });
  }

  async getDuration(filepath) {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filepath
      ]);
      let output = '';
      ffprobe.stdout.on('data', (data) => output += data.toString().trim());
      ffprobe.on('close', () => resolve(parseFloat(output) || 0));
      ffprobe.on('error', reject);
    });
  }

  async getTotalDuration(files) {
    let total = 0;
    for (const f of files) {
      total += await this.getDuration(f);
    }
    return total;
  }

  async mergeAudios(audioFiles, outputPath) {
    return new Promise((resolve, reject) => {
      // For simple merging, we re-encode to a common format (AAC) to ensure compatibility
      // Even if user wants "no re-encode", audio merging usually fails if parameters mismatch
      // and AAC encoding is very lightweight.
      
      const args = [];
      for (const af of audioFiles) {
        args.push('-i', af);
      }
      
      let filter = '';
      for (let i = 0; i < audioFiles.length; i++) {
        filter += `[${i}:a]`;
      }
      filter += `concat=n=${audioFiles.length}:v=0:a=1[aout]`;

      args.push('-filter_complex', filter, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', outputPath);
      
      const proc = spawn(ffmpegPath, args);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Failed to merge audios, code ${code}`));
      });
    });
  }

  timeToSeconds(timeStr) {
    const parts = timeStr.split(':');
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }

  async commandExists(command) {
    return new Promise((resolve) => {
      const check = spawn('which', [command]);
      check.on('close', (code) => resolve(code === 0));
    });
  }

  cancelTask(taskId) {
    const proc = this.activeTasks.get(taskId);
    if (proc) {
      proc.kill('SIGKILL');
      this.activeTasks.delete(taskId);
      return true;
    }
    return false;
  }
}

module.exports = new VideoLoopService();
