const Autolive = require('../models/Autolive');
const { db } = require('../db/database');

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
      const items = await Autolive.getItemsBySeriesId(s.id);
      console.log(`Series: ${s.name} (${s.id})`);
      console.log(`  is_active: ${s.is_active}`);
      console.log(`  status: ${s.status}`);
      console.log(`  current_item_index: ${s.current_item_index}`);
      console.log(`  items.length: ${items.length}`);
      console.log(`  repeat_mode: ${s.repeat_mode}`);
      console.log(`  start_time: ${s.start_time}`);
    }
  } catch (e) {
    console.error('Error during check:', e);
  } finally {
    process.exit();
  }
}

check();
