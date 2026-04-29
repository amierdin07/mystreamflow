const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../db/database.sqlite');
const db = new sqlite3.Database(dbPath);

async function debug() {
  try {
    const tables = await new Promise((resolve, reject) => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    
    console.log('Tables:', tables.map(t => t.name).join(', '));

    for (const table of tables) {
        const count = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as count FROM ${table.name}`, [], (err, row) => {
                if (err) resolve('?');
                else resolve(row.count);
            });
        });
        console.log(`Table ${table.name}: ${count} rows`);
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

debug();
