const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = 'D:\\Streamflow\\streamflow\\db\\streamflow.db';
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, title, thumbnail_path FROM autolive_items", (err, rows) => {
  if (err) console.error(err);
  console.log('Autolive Items in D: drive:');
  console.table(rows);
  db.close();
});
