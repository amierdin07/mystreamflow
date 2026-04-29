const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('db/streamflow.db');
db.all("SELECT * FROM streams", [], (err, rows) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(rows, null, 2));
    process.exit();
});
