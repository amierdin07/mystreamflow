const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(process.cwd(), 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  const columns = [
    'internal_playlist_id TEXT',
    'privacy TEXT DEFAULT "public"',
    'category_id TEXT DEFAULT "10"',
    'monetization_enabled INTEGER DEFAULT 0',
    'made_for_kids INTEGER DEFAULT 0',
    'playlist_id TEXT',
    'current_item_index INTEGER DEFAULT 0',
    'custom_dates TEXT'
  ];

  columns.forEach(col => {
    db.run(`ALTER TABLE autolive_series ADD COLUMN ${col}`, (err) => {
      if (err) {
        console.log(`${col.split(' ')[0]} already exists or error: ${err.message}`);
      } else {
        console.log(`Added column ${col.split(' ')[0]}`);
      }
    });
  });
});

setTimeout(() => {
  db.close();
  console.log('Done fixing columns.');
}, 2000);
