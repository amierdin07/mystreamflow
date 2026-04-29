const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

async function checkDb(dbPath) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return resolve(null);
    });

    db.get("SELECT COUNT(*) as count FROM autolive_series", (err, row) => {
      if (err) {
        db.close();
        resolve(null);
      } else {
        console.log(`Found autolive_series in ${dbPath} with ${row.count} rows`);
        db.all("SELECT * FROM autolive_series", (err, rows) => {
          if (!err) console.table(rows);
          db.close();
          resolve(row.count);
        });
      }
    });
  });
}

async function findDbs(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        await findDbs(fullPath);
      }
    } else if (file.endsWith('.db') || file.endsWith('.sqlite')) {
      await checkDb(fullPath);
    }
  }
}

console.log('Searching for databases with Autolive data...');
findDbs(process.cwd());
