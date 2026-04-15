const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

class LoopTask {
  static async create(data) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO loop_tasks (
          id, user_id, title, description, video_id, audio_ids, 
          youtube_channel_id, privacy, category, tags, status, progress, 
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, data.user_id, data.title, data.description || '', 
          data.video_id, data.audio_ids, data.youtube_channel_id, 
          data.privacy || 'unlisted', data.category || '22', data.tags || '', 
          'pending', 0, now, now
        ],
        function (err) {
          if (err) {
            console.error('Error creating loop task:', err.message);
            return reject(err);
          }
          resolve({ id, ...data, status: 'pending', progress: 0, created_at: now, updated_at: now });
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM loop_tasks WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding loop task:', err.message);
          return reject(err);
        }
        resolve(row);
      });
    });
  }

  static findAll(userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId ?
        'SELECT * FROM loop_tasks WHERE user_id = ? ORDER BY created_at DESC' :
        'SELECT * FROM loop_tasks ORDER BY created_at DESC';
      const params = userId ? [userId] : [];
      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding loop tasks:', err.message);
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }

  static update(id, taskData) {
    const fields = [];
    const values = [];
    Object.entries(taskData).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const query = `UPDATE loop_tasks SET ${fields.join(', ')} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, values, function (err) {
        if (err) {
          console.error('Error updating loop task:', err.message);
          return reject(err);
        }
        resolve({ id, ...taskData });
      });
    });
  }

  static delete(id) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM loop_tasks WHERE id = ?', [id], function (err) {
        if (err) {
          console.error('Error deleting loop task:', err.message);
          return reject(err);
        }
        resolve({ success: true, id });
      });
    });
  }
}

module.exports = LoopTask;
