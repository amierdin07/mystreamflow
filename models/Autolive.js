const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

class Autolive {
  static create(seriesData) {
    const id = uuidv4();
    const {
      user_id,
      name,
      video_id,
      start_time = null,
      repeat_mode = 'none',
      duration = 0,
      is_active = 1,
      youtube_channel_id = null
    } = seriesData;

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO autolive_series (id, user_id, name, video_id, start_time, repeat_mode, duration, is_active, youtube_channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, user_id, name, video_id, start_time, repeat_mode, duration, is_active, youtube_channel_id],
        function(err) {
          if (err) {
            console.error('Error creating autolive series:', err.message);
            return reject(err);
          }
          resolve({ id, ...seriesData });
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM autolive_series WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding autolive series:', err.message);
          return reject(err);
        }
        resolve(row);
      });
    });
  }

  static findByIdWithItems(id) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT s.*, v.title as video_title, v.filepath as video_filepath, 
                yc.channel_name as youtube_channel_name, yc.channel_thumbnail as youtube_channel_thumbnail
         FROM autolive_series s
         LEFT JOIN videos v ON s.video_id = v.id
         LEFT JOIN youtube_channels yc ON s.youtube_channel_id = yc.id
         WHERE s.id = ?`,
        [id],
        (err, series) => {
          if (err) {
            console.error('Error finding autolive series:', err.message);
            return reject(err);
          }
          if (!series) return resolve(null);

          db.all(
            `SELECT * FROM autolive_items WHERE series_id = ? ORDER BY order_index ASC`,
            [id],
            (err, items) => {
              if (err) {
                console.error('Error finding autolive items:', err.message);
                return reject(err);
              }
              series.items = items || [];
              resolve(series);
            }
          );
        }
      );
    });
  }

  static findAll(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT s.*, 
                (SELECT COUNT(*) FROM autolive_items WHERE series_id = s.id) as item_count,
                v.title as video_title,
                yc.channel_name as youtube_channel_name
         FROM autolive_series s
         LEFT JOIN videos v ON s.video_id = v.id
         LEFT JOIN youtube_channels yc ON s.youtube_channel_id = yc.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) {
            console.error('Error finding autolive series:', err.message);
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  static update(id, seriesData) {
    const fields = [];
    const values = [];

    Object.entries(seriesData).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const query = `UPDATE autolive_series SET ${fields.join(', ')} WHERE id = ?`;

    return new Promise((resolve, reject) => {
      db.run(query, values, function(err) {
        if (err) {
          console.error('Error updating autolive series:', err.message);
          return reject(err);
        }
        resolve({ id, ...seriesData });
      });
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM autolive_items WHERE series_id = ?',
        [id],
        (err) => {
          if (err) return reject(err);
          db.run(
            'DELETE FROM autolive_series WHERE id = ? AND user_id = ?',
            [id, userId],
            function(err) {
              if (err) return reject(err);
              resolve({ success: true, deleted: this.changes > 0 });
            }
          );
        }
      );
    });
  }

  static addItem(itemData) {
    const id = uuidv4();
    const {
      series_id,
      title,
      description = '',
      tags = '',
      thumbnail_path = null,
      original_thumbnail_path = null,
      order_index
    } = itemData;

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO autolive_items (id, series_id, title, description, tags, thumbnail_path, original_thumbnail_path, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, series_id, title, description, tags, thumbnail_path, original_thumbnail_path, order_index],
        function(err) {
          if (err) {
            console.error('Error adding autolive item:', err.message);
            return reject(err);
          }
          resolve({ id, ...itemData });
        }
      );
    });
  }

  static deleteItemsBySeriesId(seriesId) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM autolive_items WHERE series_id = ?', [seriesId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  static getItemsBySeriesId(seriesId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM autolive_items WHERE series_id = ? ORDER BY order_index ASC',
        [seriesId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  static findActiveSeries() {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM autolive_series WHERE is_active = 1",
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }
}

module.exports = Autolive;
