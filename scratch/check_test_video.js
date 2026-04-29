const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../db/streamflow.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, title, thumbnail_path FROM videos WHERE title LIKE '%test auto live%'", (err, rows) => {
  if (err) console.error(err);
  console.log('Videos with "test auto live":');
  console.table(rows);
  db.close();
});
