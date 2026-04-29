const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../db/streamflow.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, title, youtube_thumbnail, video_id FROM streams", (err, rows) => {
  if (err) console.error(err);
  console.table(rows);
  db.close();
});
