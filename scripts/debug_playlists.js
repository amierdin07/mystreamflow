const sqlite3 = require('sqlite3').verbose();

const dbPath = '/root/db/streamflow.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  console.log("=== USERS ===");
  db.all("SELECT id, username, email FROM users", [], (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
  });

  console.log("\n=== YOUTUBE CHANNELS ===");
  db.all("SELECT id, channel_name, channel_id, is_default FROM youtube_channels", [], (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
  });

  console.log("\n=== PLAYLISTS ===");
  db.all("SELECT id, name, user_id, youtube_channel_id FROM playlists", [], (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
  });

  console.log("\n=== VIDEOS COUNT ===");
  db.all("SELECT youtube_channel_id, COUNT(*) as count FROM videos GROUP BY youtube_channel_id", [], (err, rows) => {
    if (err) console.error(err);
    else console.log(rows);
    db.close();
  });
});
