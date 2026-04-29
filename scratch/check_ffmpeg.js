const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { spawn } = require('child_process');

console.log('FFmpeg Path:', ffmpegInstaller.path);
console.log('FFmpeg Version:', ffmpegInstaller.version);

const ffmpeg = spawn(ffmpegInstaller.path, ['-version']);

ffmpeg.stdout.on('data', (data) => {
    console.log('FFmpeg Output:', data.toString().split('\n')[0]);
});

ffmpeg.stderr.on('data', (data) => {
    console.error('FFmpeg Error:', data.toString());
});

ffmpeg.on('close', (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
});
