const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../db/streamflow.db');
const db = new sqlite3.Database(dbPath);

console.log('Using database at:', dbPath);

console.log('\n--- Checking Active Autolive Series ---');
db.all("SELECT id, name, current_item_index, status FROM autolive_series WHERE is_active = 1", [], (err, series) => {
    if (err) {
        console.error('Error fetching series:', err.message);
    } else {
        console.log(`Found ${series.length} active series:`);
        if (series.length === 0) {
            // Check all series if none active
            db.all("SELECT id, name, is_active FROM autolive_series", [], (err, allSeries) => {
                console.log('All series:', allSeries);
            });
        }
        series.forEach(s => {
            console.log(`- ID: ${s.id}, Name: ${s.name}, Index: ${s.current_item_index}, Status: ${s.status}`);
            
            // Check items for this series
            db.all("SELECT title, thumbnail_path FROM autolive_items WHERE series_id = ? ORDER BY order_index ASC", [s.id], (err, items) => {
                if (err) {
                    console.error('  Error fetching items:', err.message);
                } else {
                    console.log(`  Items (${items.length}):`);
                    items.forEach((item, idx) => {
                        console.log(`    [${idx}] ${item.title}: ${item.thumbnail_path}`);
                    });
                }
            });

            // Check linked stream
            const streamId = `autolive_${s.id}`;
            db.get("SELECT id, title, youtube_thumbnail, status FROM streams WHERE id = ?", [streamId], (err, stream) => {
                if (err) {
                    console.error('  Error fetching stream:', err.message);
                } else if (stream) {
                    console.log(`  Linked Stream (tasklive):`);
                    console.log(`    ID: ${stream.id}, Title: ${stream.title}, Thumbnail: ${stream.youtube_thumbnail}, Status: ${stream.status}`);
                } else {
                    console.log(`  No linked stream found for ID: ${streamId}`);
                }
            });
        });
    }
});
