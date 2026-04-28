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
    
    console.log('--- Autolive Series ---');
    for (const s of series) {
      const items = await Autolive.getItemsBySeriesId(s.id);
      console.log(`ID: ${s.id}`);
      console.log(`Name: ${s.name}`);
      console.log(`Is Active: ${s.is_active}`);
      console.log(`Status: ${s.status}`);
      console.log(`Current Item Index: ${s.current_item_index}`);
      console.log(`Items Count: ${items.length}`);
      console.log(`Start Time: ${s.start_time}`);
      console.log(`Repeat Mode: ${s.repeat_mode}`);
      console.log('-----------------------');
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}

check();
