const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../db/database.sqlite');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, series_id, title, thumbnail_path, original_thumbnail_path FROM autolive_items ORDER BY id DESC LIMIT 5", [], (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log(rows);
    }
});
