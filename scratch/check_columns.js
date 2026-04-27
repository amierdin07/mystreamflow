const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(process.cwd(), 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

db.all("PRAGMA table_info(autolive_series)", (err, rows) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(rows.map(r => r.name)));
    db.close();
});
