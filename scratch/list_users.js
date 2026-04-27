const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(process.cwd(), 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, username FROM users", (err, rows) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(rows));
    db.close();
});
