const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../db/streamflow.db');

if (!fs.existsSync(dbPath)) {
  console.error('DATABASE FILE NOT FOUND at:', dbPath);
  process.exit(1);
}

const stats = fs.statSync(dbPath);
console.log(`Database file size: ${stats.size} bytes`);

const db = new sqlite3.Database(dbPath);

console.log('Checking Autolive data in:', dbPath);

function query(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function run() {
  try {
    console.log('\n--- Autolive Series ---');
    const series = await query('SELECT id, name, current_item_index FROM autolive_series');
    console.table(series);

    console.log('\n--- Autolive Items ---');
    const items = await query('SELECT id, series_id, title, thumbnail_path FROM autolive_items');
    console.table(items);

    console.log('\n--- Related Streams ---');
    const streams = await query("SELECT id, title, youtube_thumbnail FROM streams WHERE id LIKE 'autolive_%'");
    console.table(streams);
  } catch (err) {
    console.error('Query error:', err);
  } finally {
    db.close();
  }
}

run();
