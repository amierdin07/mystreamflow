const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('db/streamflow.db');
db.all("PRAGMA table_info(streams)", [], (err, rows) => {
    if (err) console.error(err);
    else console.log('Columns:', rows.map(r => r.name).join(', '));
    process.exit();
});
