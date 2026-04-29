const { db } = require('../db/database');
const Autolive = require('../models/Autolive');
const Stream = require('../models/Stream');

async function debug() {
  try {
    const seriesRows = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM autolive_series', [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    
    console.log('--- Autolive Series ---');
    if (seriesRows.length === 0) {
        console.log('No autolive series found.');
    }

    for (const s of seriesRows) {
      console.log(`ID: ${s.id}, Name: ${s.name}, Status: ${s.status}, Active: ${s.is_active}`);
      
      const items = await Autolive.getItemsBySeriesId(s.id);
      console.log('  Items:');
      for (const item of items) {
        console.log(`    - Title: ${item.title}, Thumbnail: ${item.thumbnail_path}`);
      }
      
      const streamId = `autolive_${s.id}`;
      const stream = await Stream.findById(streamId);
      if (stream) {
        console.log(`  Linked Stream: ID=${stream.id}, Title=${stream.title}, Thumbnail=${stream.youtube_thumbnail}, BroadcastID=${stream.youtube_broadcast_id}`);
      } else {
        console.log(`  Linked Stream: NOT FOUND (${streamId})`);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

debug();
