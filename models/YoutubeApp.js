const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

class YoutubeApp {
  static findAll(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM youtube_apps WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM youtube_apps WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  static create(data) {
    const id = uuidv4();
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO youtube_apps (id, user_id, name, client_id, client_secret)
         VALUES (?, ?, ?, ?, ?)`,
        [
          id,
          data.user_id,
          data.name,
          data.client_id,
          data.client_secret
        ],
        function (err) {
          if (err) return reject(err);
          resolve({ id, ...data });
        }
      );
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM youtube_apps WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) return reject(err);
          resolve(this.changes > 0);
        }
      );
    });
  }
}

module.exports = YoutubeApp;
