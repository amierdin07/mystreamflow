const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = '/root/db/streamflow.db';
if (!fs.existsSync(dbPath)) {
  console.error("Database file not found at:", dbPath);
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all("SELECT id, channel_name, channel_id FROM youtube_channels", [], (err, channels) => {
    if (err) {
      console.error("Error reading youtube_channels:", err.message);
      db.close();
      process.exit(1);
    }

    if (channels.length === 0) {
      console.error("No YouTube channels found in the database. Please connect your YouTube channel first!");
      db.close();
      process.exit(1);
    }

    const newChannel = channels[0];
    const newId = newChannel.id;
    console.log(`Found active channel: ${newChannel.channel_name} (Database ID: ${newId}, YouTube ID: ${newChannel.channel_id})`);

    const tablesToUpdate = [
      'playlists',
      'videos',
      'media_folders',
      'autolive_series',
      'stream_rotations',
      'streams'
    ];

    let completed = 0;
    
    tablesToUpdate.forEach(table => {
      const query = `UPDATE ${table} SET youtube_channel_id = ? WHERE youtube_channel_id IS NOT NULL AND youtube_channel_id != ?`;
      
      db.run(query, [newId, newId], function(err) {
        if (err) {
          console.error(`Error updating table ${table}:`, err.message);
        } else {
          console.log(`Updated table ${table}: ${this.changes} rows modified.`);
        }
        
        completed++;
        if (completed === tablesToUpdate.length) {
          console.log("\nDatabase repair completed successfully!");
          db.close();
        }
      });
    });
  });
});
