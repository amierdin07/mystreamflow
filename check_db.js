const { db } = require('./db/database');

async function run() {
  try {
    const activeStreams = await new Promise((resolve) => {
      db.all("SELECT id, title, video_id, status, schedule_time, end_time FROM streams WHERE id LIKE 'autolive_%'", [], (err, rows) => {
        resolve(rows || []);
      });
    });
    console.log("=== AUTOLIVE STREAMS IN DB ===");
    console.log(JSON.stringify(activeStreams, null, 2));

    const series = await new Promise((resolve) => {
      db.all("SELECT * FROM autolive_series", [], (err, rows) => {
        resolve(rows || []);
      });
    });
    console.log("=== AUTOLIVE SERIES IN DB ===");
    console.log(JSON.stringify(series, null, 2));

    const items = await new Promise((resolve) => {
      db.all("SELECT * FROM autolive_items", [], (err, rows) => {
        resolve(rows || []);
      });
    });
    console.log("=== AUTOLIVE ITEMS IN DB ===");
    console.log(JSON.stringify(items, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
