const { db } = require('../db/database');

async function check() {
  try {
    const tables = await new Promise((resolve, reject) => {
      db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log('Tables found:', tables.map(t => t.name).join(', '));
    
    for (const table of tables) {
      const count = await new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as count FROM ${table.name}`, [], (err, row) => {
          if (err) resolve('error');
          else resolve(row.count);
        });
      });
      console.log(`Table ${table.name}: ${count} rows`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}

check();
