const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

class MediaFolder {
  static create({ name, user_id, youtube_channel_id }) {
    const id = uuidv4();
    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO media_folders (id, name, user_id, youtube_channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, user_id, youtube_channel_id || null, now, now],
        function(err) {
          if (err) {
            console.error('Error creating media folder:', err.message);
            return reject(err);
          }
          resolve({ id, name, user_id, created_at: now, updated_at: now });
        }
      );
    });
  }

  static findById(id, userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId
        ? 'SELECT * FROM media_folders WHERE id = ? AND user_id = ?'
        : 'SELECT * FROM media_folders WHERE id = ?';
      const params = userId ? [id, userId] : [id];
      db.get(query, params, (err, row) => {
        if (err) {
          console.error('Error finding media folder:', err.message);
          return reject(err);
        }
        resolve(row || null);
      });
    });
  }

  static findAllByUserAndChannel(userId, channelId = null) {
    return new Promise((resolve, reject) => {
      let query = `SELECT mf.*,
                (SELECT COUNT(*) FROM videos v WHERE v.folder_id = mf.id) AS item_count
         FROM media_folders mf
         WHERE mf.user_id = ? `;
      const params = [userId];

      if (channelId) {
        if (channelId === 'general') {
          query += 'AND (mf.youtube_channel_id IS NULL OR mf.youtube_channel_id = \'\') ';
        } else {
          query += 'AND mf.youtube_channel_id = ? ';
          params.push(channelId);
        }
      }

      query += 'ORDER BY LOWER(mf.name) ASC';

      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding media folders:', err.message);
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }

  static findByNameAndChannel(userId, name, channelId = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM media_folders WHERE user_id = ? AND LOWER(name) = LOWER(?) ';
      const params = [userId, name];

      if (channelId) {
        if (channelId === 'general') {
          query += 'AND (youtube_channel_id IS NULL OR youtube_channel_id = \'\')';
        } else {
          query += 'AND youtube_channel_id = ?';
          params.push(channelId);
        }
      } else {
        // Technically findByName might have been used without knowing channel, 
        // we'll keep it as-is if channelId is not provided (which could return the first match).
      }

      db.get(query, params, (err, row) => {
        if (err) {
          console.error('Error finding media folder by name:', err.message);
          return reject(err);
        }
        resolve(row || null);
      });
    });
  }

  static update(id, userId, data) {
    const fields = [];
    const values = [];

    Object.entries(data).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    fields.push('updated_at = ?');
    values.push(new Date().toISOString(), id, userId);

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE media_folders SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
        values,
        function(err) {
          if (err) {
            console.error('Error updating media folder:', err.message);
            return reject(err);
          }
          resolve({ id, ...data });
        }
      );
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM media_folders WHERE id = ? AND user_id = ?',
        [id, userId],
        function(err) {
          if (err) {
            console.error('Error deleting media folder:', err.message);
            return reject(err);
          }
          resolve({ success: true, id });
        }
      );
    });
  }
}

module.exports = MediaFolder;
