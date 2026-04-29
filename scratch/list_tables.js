const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../db/streamflow.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.log('Tables in streamflow.db:');
    rows.forEach(row => console.log(' - ' + row.name));
    
    if (rows.length > 0) {
      console.log('\nRow counts:');
      rows.forEach(row => {
        db.get(`SELECT COUNT(*) as count FROM ${row.name}`, (err, countRow) => {
          if (!err) console.log(` - ${row.name}: ${countRow.count}`);
        });
      });
    }
  }
  // Wait a bit for counts to finish
  setTimeout(() => db.close(), 1000);
});
