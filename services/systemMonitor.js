const si = require('systeminformation');
const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, '../network_usage.json');

let previousNetworkData = null;
let previousTimestamp = null;
let initialNetworkTotal = null;

// Persistent totals
let cumulativeDownload = 0;
let cumulativeUpload = 0;
let lastRecordedTotal = { rx_bytes: 0, tx_bytes: 0 };

// Load saved usage on startup
function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      cumulativeDownload = data.cumulativeDownload || 0;
      cumulativeUpload = data.cumulativeUpload || 0;
      lastRecordedTotal = data.lastRecordedTotal || { rx_bytes: 0, tx_bytes: 0 };
    }
  } catch (error) {
    console.error('Error loading network usage:', error);
  }
}

// Save usage periodically
function saveUsage() {
  try {
    const data = {
      cumulativeDownload,
      cumulativeUpload,
      lastRecordedTotal,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving network usage:', error);
  }
}

loadUsage();

async function getSystemStats() {
  try {
    const [cpuData, memData, networkData, diskData, processesData] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      getDiskUsage(),
      si.processes()
    ]);
    
    const cpuUsage = cpuData.currentLoad || cpuData.avg || 0;
    
    const networkInfo = calculateNetworkInfo(networkData);
    
    const formatMemory = (bytes) => {
      if (bytes >= 1073741824) {
        return (bytes / 1073741824).toFixed(2) + " GB";
      } else {
        return (bytes / 1048576).toFixed(2) + " MB";
      }
    };

    const ffmpegProcesses = (processesData.list || [])
      .filter(p => p.name.toLowerCase().includes('ffmpeg'))
      .map(p => ({
        pid: p.pid,
        cpu: p.cpu,
        mem: p.mem,
        name: p.name
      }));
    
    return {
      cpu: {
        usage: Math.round(cpuUsage),
        cores: cpuData.cpus ? cpuData.cpus.length : 0
      },
      memory: {
        total: formatMemory(memData.total),
        used: formatMemory(memData.active),
        free: formatMemory(memData.available),
        usagePercent: Math.round((memData.active / memData.total) * 100)
      },
      network: networkInfo,
      disk: diskData,
      processes: ffmpegProcesses,
      platform: process.platform,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('Error getting system stats:', error);
    return {
      cpu: { usage: 0, cores: 0 },
      memory: { total: "0 GB", used: "0 GB", free: "0 GB", usagePercent: 0 },
      network: { 
        download: 0, 
        upload: 0, 
        downloadFormatted: '0 Mbps', 
        uploadFormatted: '0 Mbps',
        totalDownloadFormatted: formatBytes(cumulativeDownload),
        totalUploadFormatted: formatBytes(cumulativeUpload)
      },
      disk: { total: "0 GB", used: "0 GB", free: "0 GB", usagePercent: 0, drive: "N/A" },
      platform: process.platform,
      timestamp: Date.now()
    };
  }
}

function calculateNetworkInfo(networkData) {
  const currentTimestamp = Date.now();
  
  const currentTotal = networkData
    .filter(iface => !iface.iface.includes('lo') && !iface.iface.includes('Loopback') && iface.operstate === 'up')
    .reduce((acc, iface) => ({
      rx_bytes: acc.rx_bytes + (iface.rx_bytes || 0),
      tx_bytes: acc.tx_bytes + (iface.tx_bytes || 0)
    }), { rx_bytes: 0, tx_bytes: 0 });

  // If this is the first run after restart
  if (!initialNetworkTotal) {
    initialNetworkTotal = currentTotal;
    
    // Check if system totals are less than last recorded (e.g. system reboot)
    if (currentTotal.rx_bytes < lastRecordedTotal.rx_bytes) {
      // System rebooted, just start from current system total
      lastRecordedTotal = currentTotal;
    }
  }

  // Calculate incremental change since last measurement
  if (lastRecordedTotal.rx_bytes > 0) {
    const deltaRx = Math.max(0, currentTotal.rx_bytes - lastRecordedTotal.rx_bytes);
    const deltaTx = Math.max(0, currentTotal.tx_bytes - lastRecordedTotal.tx_bytes);
    
    // Only update if there is significant change or it's been a while
    if (deltaRx > 0 || deltaTx > 0) {
      cumulativeDownload += deltaRx;
      cumulativeUpload += deltaTx;
      lastRecordedTotal = currentTotal;
      saveUsage(); // Save on every change
    }
  } else {
    lastRecordedTotal = currentTotal;
  }
  
  if (!previousNetworkData || !previousTimestamp) {
    previousNetworkData = networkData;
    previousTimestamp = currentTimestamp;
    return {
      download: 0,
      upload: 0,
      downloadFormatted: '0 Mbps',
      uploadFormatted: '0 Mbps',
      totalDownloadFormatted: formatBytes(cumulativeDownload),
      totalUploadFormatted: formatBytes(cumulativeUpload)
    };
  }
  
  const timeDiff = (currentTimestamp - previousTimestamp) / 1000;
  
  const previousTotal = previousNetworkData
    .filter(iface => !iface.iface.includes('lo') && !iface.iface.includes('Loopback'))
    .reduce((acc, iface) => ({
      rx_bytes: acc.rx_bytes + (iface.rx_bytes || 0),
      tx_bytes: acc.tx_bytes + (iface.tx_bytes || 0)
    }), { rx_bytes: 0, tx_bytes: 0 });
  
  const downloadBps = Math.max(0, (currentTotal.rx_bytes - previousTotal.rx_bytes) / timeDiff);
  const uploadBps = Math.max(0, (currentTotal.tx_bytes - previousTotal.tx_bytes) / timeDiff);
  
  const downloadMbps = (downloadBps * 8) / (1024 * 1024);
  const uploadMbps = (uploadBps * 8) / (1024 * 1024);
  
  previousNetworkData = networkData;
  previousTimestamp = currentTimestamp;
  
  return {
    download: downloadMbps,
    upload: uploadMbps,
    downloadFormatted: formatSpeed(downloadMbps),
    uploadFormatted: formatSpeed(uploadMbps),
    totalDownloadFormatted: formatBytes(cumulativeDownload),
    totalUploadFormatted: formatBytes(cumulativeUpload)
  };
}

function formatSpeed(speedMbps) {
  if (speedMbps >= 1000) {
    return (speedMbps / 1000).toFixed(2) + ' Gbps';
  } else if (speedMbps >= 1) {
    return speedMbps.toFixed(2) + ' Mbps';
  } else {
    return (speedMbps * 1000).toFixed(0) + ' Kbps';
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getDiskUsage() {
  try {
    const fsSize = await si.fsSize();
    const platform = process.platform;
    
    let targetDisk;
    
    if (platform === 'win32') {
      const currentDrive = process.cwd().charAt(0).toUpperCase();
      targetDisk = fsSize.find(disk => disk.mount.charAt(0).toUpperCase() === currentDrive);
      
      if (!targetDisk) {
        targetDisk = fsSize.find(disk => disk.mount.charAt(0).toUpperCase() === 'C');
      }
    } else {
      targetDisk = fsSize.find(disk => disk.mount === '/');
    }
    
    if (!targetDisk) {
      targetDisk = fsSize[0];
    }
    
    if (!targetDisk) {
      return {
        total: "0 GB",
        used: "0 GB", 
        free: "0 GB",
        usagePercent: 0,
        drive: "N/A"
      };
    }
    
    const formatDisk = (bytes) => {
      if (bytes >= 1099511627776) {
        return (bytes / 1099511627776).toFixed(2) + " TB";
      } else if (bytes >= 1073741824) {
        return (bytes / 1073741824).toFixed(2) + " GB";
      } else {
        return (bytes / 1048576).toFixed(2) + " MB";
      }
    };
    
    const usagePercent = targetDisk.size > 0 ? 
      Math.round(((targetDisk.size - targetDisk.available) / targetDisk.size) * 100) : 0;
    
    return {
      total: formatDisk(targetDisk.size),
      used: formatDisk(targetDisk.size - targetDisk.available),
      free: formatDisk(targetDisk.available),
      usagePercent: usagePercent,
      drive: targetDisk.mount || targetDisk.fs || "Unknown"
    };
  } catch (error) {
    console.error('Error getting disk usage:', error);
    return {
      total: "0 GB",
      used: "0 GB",
      free: "0 GB", 
      usagePercent: 0,
      drive: "N/A"
    };
  }
}

module.exports = { getSystemStats };