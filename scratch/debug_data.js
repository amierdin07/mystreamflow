const { db } = require('../db/database');

async function debug() {
  try {
    const streams = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM streams", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    
    console.log('--- Streams ---');
    console.log(JSON.stringify(streams, null, 2));

    const autolive = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM autolive_series", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    console.log('--- Autolive Series ---');
    console.log(JSON.stringify(autolive, null, 2));

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

debug();
