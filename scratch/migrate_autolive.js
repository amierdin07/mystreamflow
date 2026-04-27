const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run("ALTER TABLE autolive_series ADD COLUMN internal_playlist_id TEXT", (err) => {
        if (err) console.log('Column might already exist');
        else console.log('Added internal_playlist_id column');
        db.close();
    });
});
