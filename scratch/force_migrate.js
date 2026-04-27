const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(process.cwd(), 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 1. Tambah internal_playlist_id
    db.run("ALTER TABLE autolive_series ADD COLUMN internal_playlist_id TEXT", (err) => {
        if (err) console.log('internal_playlist_id: Already exists or error');
        else console.log('internal_playlist_id: Added successfully');
    });

    // 2. Tambah kolom metadata YouTube (jika belum ada)
    const columns = [
        'privacy TEXT DEFAULT "public"',
        'category_id TEXT DEFAULT "10"',
        'monetization_enabled INTEGER DEFAULT 0',
        'made_for_kids INTEGER DEFAULT 0',
        'playlist_id TEXT'
    ];

    columns.forEach(col => {
        db.run(`ALTER TABLE autolive_series ADD COLUMN ${col}`, (err) => {
            if (err) console.log(`${col.split(' ')[0]}: Already exists or error`);
            else console.log(`${col.split(' ')[0]}: Added successfully`);
        });
    });

    // 3. Pastikan current_item_index ada
    db.run("ALTER TABLE autolive_series ADD COLUMN current_item_index INTEGER DEFAULT 0", (err) => {
        if (err) console.log('current_item_index: Already exists or error');
        else console.log('current_item_index: Added successfully');
    });

    // 4. Ubah video_id agar boleh NULL (SQLite tricky, kita biarkan saja tapi pastikan query aman)
    
    setTimeout(() => {
        db.close();
        console.log('Database migration completed.');
    }, 2000);
});
