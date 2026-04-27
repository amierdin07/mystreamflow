const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(process.cwd(), 'db', 'streamflow.db');
const db = new sqlite3.Database(dbPath);

const Autolive = require('../models/Autolive');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const YoutubeChannel = require('../models/YoutubeChannel');

async function debug() {
    db.get("SELECT id FROM users LIMIT 1", async (err, user) => {
        if (!user) {
            console.log("No user found in DB");
            process.exit(1);
        }
        const userId = user.id;
        console.log("Testing with User ID:", userId);

        try {
            console.log("1. Testing Video.findAll...");
            const allVideos = await Video.findAll(userId);
            console.log("   Found:", allVideos.length, "videos");

            console.log("2. Testing Autolive.findAll...");
            const series = await Autolive.findAll(userId);
            console.log("   Found:", series.length, "series");

            console.log("3. Testing YoutubeChannel.findAll...");
            const channels = await YoutubeChannel.findAll(userId);
            console.log("   Found:", channels.length, "channels");

            console.log("4. Testing Playlist.findAll...");
            const playlists = await Playlist.findAll(userId);
            console.log("   Found:", playlists.length, "playlists");

            console.log("SUCCESS: All data loaded correctly.");
        } catch (e) {
            console.error("FAILED at step:", e.message);
            console.error(e.stack);
        } finally {
            db.close();
        }
    });
}

debug();
