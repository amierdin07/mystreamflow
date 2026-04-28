const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = 'c:\\Users\\user\\Documents\\GitHub\\mystream\\db\\streamflow.db';
const db = new sqlite3.Database(dbPath);

async function check() {
  try {
    const series = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM autolive_series", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log(`Found ${series.length} series.`);
    for (const s of series) {
      console.log(`Series: ${s.name} (${s.id})`);
      console.log(`  is_active: ${s.is_active}`);
      console.log(`  status: ${s.status}`);
      console.log(`  current_item_index: ${s.current_item_index}`);
      console.log(`  repeat_mode: ${s.repeat_mode}`);
      console.log(`  start_time: ${s.start_time}`);
      
      const items = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM autolive_items WHERE series_id = ?", [s.id], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
      console.log(`  items.length: ${items.length}`);
    }
  } catch (e) {
    console.error('Error during check:', e);
  } finally {
    db.close();
  }
}

check();
