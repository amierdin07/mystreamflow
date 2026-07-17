const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function checkDb(dbPath) {
  console.log(`\n==========================================`);
  console.log(`Checking DB: ${dbPath}`);
  console.log(`==========================================`);
  const db = new sqlite3.Database(dbPath);
  
  try {
    const channels = await new Promise((resolve) => {
      db.all("SELECT id, channel_id, channel_name, is_default FROM youtube_channels", [], (err, rows) => {
        if (err) console.error("Error channels:", err.message);
        resolve(rows || []);
      });
    });
    console.log("=== YOUTUBE CHANNELS IN DB ===");
    console.log(JSON.stringify(channels, null, 2));

    const playlists = await new Promise((resolve) => {
      db.all("SELECT id, name, youtube_channel_id FROM playlists", [], (err, rows) => {
        if (err) console.error("Error playlists:", err.message);
        resolve(rows || []);
      });
    });
    console.log("=== PLAYLISTS IN DB ===");
    console.log(JSON.stringify(playlists, null, 2));

    const videos = await new Promise((resolve) => {
      db.all("SELECT id, title, youtube_channel_id FROM videos LIMIT 10", [], (err, rows) => {
        if (err) console.error("Error videos:", err.message);
        resolve(rows || []);
      });
    });
    console.log("=== VIDEOS (LIMIT 10) ===");
    console.log(JSON.stringify(videos, null, 2));
    
  } catch (err) {
    console.error(err);
  } finally {
    db.close();
  }
}

async function run() {
  await checkDb(path.join(__dirname, 'db', 'streamflow.db'));
  process.exit(0);
}

run();
