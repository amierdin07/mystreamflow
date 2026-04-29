const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../db/streamflow.db');
const db = new sqlite3.Database(dbPath);

console.log('Checking Autolive data in:', dbPath);

db.serialize(() => {
  console.log('\n--- Autolive Series ---');
  db.all('SELECT id, name, current_item_index FROM autolive_series', (err, rows) => {
    if (err) console.error(err);
    console.table(rows);
  });

  console.log('\n--- Autolive Items ---');
  db.all('SELECT id, series_id, title, thumbnail_path FROM autolive_items', (err, rows) => {
    if (err) console.error(err);
    console.table(rows);
  });

  console.log('\n--- Related Streams ---');
  db.all("SELECT id, title, youtube_thumbnail FROM streams WHERE id LIKE 'autolive_%'", (err, rows) => {
    if (err) console.error(err);
    console.table(rows);
    db.close();
  });
});
