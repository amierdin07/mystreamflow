const axios = require('axios');
const User = require('../models/User');

/**
 * Service to handle notifications (e.g., Telegram)
 */
class NotificationService {
  /**
   * Sends a message to a user's Telegram
   * @param {string} userId - The user's ID
   * @param {string} message - The message to send
   */
  static async sendTelegramMessage(userId, message) {
    try {
      const user = await User.findById(userId);
      if (!user || !user.telegram_bot_token || !user.telegram_chat_id) {
        // Silently skip if Telegram is not configured
        return { success: false, error: 'Telegram not configured' };
      }

      const botToken = user.telegram_bot_token;
      const chatId = user.telegram_chat_id;
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

      const response = await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      });

      return { success: true, data: response.data };
    } catch (error) {
      console.error('[NotificationService] Telegram Error:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sends a poor signal notification
   * @param {string} userId - The user's ID
   * @param {string} streamTitle - The stream title
   * @param {string} status - The signal status
   */
  static async sendPoorSignalNotification(userId, streamTitle, status, issues = []) {
    let issueText = '';
    if (issues && issues.length > 0) {
      issueText = '\n\n<b>Masalah Terdeteksi:</b>';
      issues.forEach(issue => {
        issueText += `\n• ${issue.reason || issue.type}${issue.description ? ` (${issue.description})` : ''}`;
      });
    }
    const message = `⚠️ <b>Streaming Alert!</b>\n\nSignal untuk stream <b>${streamTitle}</b> saat ini berstatus: <b>${status.toUpperCase()}</b>.${issueText}\n\nSegera cek koneksi internet atau server Anda!`;
    return this.sendTelegramMessage(userId, message);
  }
}

module.exports = NotificationService;
