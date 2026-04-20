#!/bin/bash

# ================================================================
#  StreamFlow Backup Script
# ================================================================

# Nama aplikasi di PM2
APP_NAME="streamflow"
# Nama file backup
BACKUP_NAME="backup_streamflow_$(date +%Y%m%d_%H%M%S).zip"

echo "📂 Memulai proses backup untuk StreamFlow..."

# 1. Cek apakah zip terinstall
if ! command -v zip &> /dev/null; then
    echo "📦 Menginstall zip..."
    sudo apt-get update && sudo apt-get install -y zip
fi

# 2. Matikan aplikasi sebentar agar database tidak korup
echo "🛑 Menghentikan aplikasi $APP_NAME..."
pm2 stop $APP_NAME

# 3. Proses Zipping
echo "🤐 Mengompres data (database, .env, uploads)..."
zip -r $BACKUP_NAME db .env public/uploads

# 4. Jalankan kembali aplikasi
echo "▶️ Menjalankan kembali aplikasi $APP_NAME..."
pm2 start $APP_NAME

echo "================================================================"
echo "✅ BACKUP SELESAI!"
echo "File backup: $BACKUP_NAME"
echo "Lokasi: $(pwd)/$BACKUP_NAME"
echo "================================================================"
echo "Silakan download file tersebut menggunakan WinSCP / FileZilla"
echo "atau gunakan perintah SCP untuk transfer ke VPS baru."
echo "================================================================"
