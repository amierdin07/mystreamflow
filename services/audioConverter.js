const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const path = require('path');
const fs = require('fs-extra');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const getAudioInfo = (filepath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      resolve({
        duration: metadata.format.duration || 0,
        codec: audioStream ? audioStream.codec_name : null,
        bitrate: metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : null,
        sampleRate: audioStream ? audioStream.sample_rate : null,
        channels: audioStream ? audioStream.channels : null,
        fileSize: metadata.format.size || 0
      });
    });
  });
};

const isAacCodec = async (filepath) => {
  const info = await getAudioInfo(filepath);
  return info.codec === 'aac';
};

const convertToAac = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions(['-vn', '-movflags +faststart'])
      .toFormat('ipod')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(err);
      })
      .save(outputPath);
  });
};

const processAudioFile = async (inputPath, originalFilename) => {
  const basename = path.basename(inputPath, path.extname(inputPath));
  const tempOutputPath = path.join(path.dirname(inputPath), `${basename}_converted.m4a`);
  const finalOutputPath = path.join(path.dirname(inputPath), `${basename}.m4a`);
  
  // Always convert to ensure 128k AAC with -movflags +faststart is applied
  await convertToAac(inputPath, tempOutputPath);
  
  if (fs.existsSync(inputPath)) {
    await fs.remove(inputPath);
  }
  
  await fs.move(tempOutputPath, finalOutputPath, { overwrite: true });
  
  return {
    filepath: finalOutputPath,
    converted: true
  };
};

const generateAudioThumbnail = (outputPath) => {
  return new Promise((resolve) => {
    const defaultThumb = '/images/audio-thumbnail.svg';
    resolve(defaultThumb);
  });
};

module.exports = {
  getAudioInfo,
  isAacCodec,
  convertToAac,
  processAudioFile,
  generateAudioThumbnail
};
