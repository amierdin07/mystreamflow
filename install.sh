#!/bin/bash
set -e

# ================================================================
#  StreamFlow Auto Installer (Universal Version - GLIBC Fix)
# ================================================================

# Memastikan sistem tidak memunculkan dialog pop-up (layar ungu)
export DEBIAN_FRONTEND=noninteractive

echo "🚀 Memulai Instalasi StreamFlow (Optimized for your VPS)..."
sleep 2

# 1. Update & Install Dependency Dasar + Build Tools
echo "🔄 Updating sistem & menginstall build-essential..."
sudo apt-get update
sudo apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade
sudo apt-get install -y git ffmpeg nginx certbot python3-certbot-nginx build-essential

# 2. Install Node.js v22
echo "📦 Menginstall Node.js v22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Clone Repository Amierdin07
echo "📥 Mengkloning repository mystreamflow..."
if [ -d "mystreamflow" ]; then
    echo "⚠️ Folder mystreamflow sudah ada, menghapus folder lama agar fresh..."
    rm -rf mystreamflow
fi
git clone https://github.com/amierdin07/mystreamflow.git
cd mystreamflow

# 4. Install Module & Rebuild SQLite3 (Fix GLIBC Error)
echo "⚙️ Menginstall Node modules & merakit SQLite3 (tahap ini butuh waktu)..."
npm install
npm rebuild sqlite3 --build-from-source
node generate-secret.js

# 5. Setup Zona Waktu
echo "🕐 Mengatur zona waktu ke WIB (Jakarta)..."
sudo timedatectl set-timezone Asia/Jakarta

# 6. Install & Setup PM2
echo "🚀 Menginstall PM2..."
sudo npm install -g pm2

echo "▶️ Menjalankan aplikasi dengan PM2..."
pm2 delete streamflow 2>/dev/null || true
pm2 start app.js --name streamflow
pm2 save
pm2 startup | tail -1 | bash || true

# 7. Selesai
clear
echo "================================================================"
echo "✅ INSTALASI SELESAI & DATABASE TELAH DIPERBAIKI!"
echo "================================================================"
IP_VPS=$(curl -s ifconfig.me)
echo "Aplikasi berjalan di: http://$IP_VPS:7575"
echo ""
echo "Sekarang coba buka browser kamu. Harusnya sudah Lancar Jaya!"
echo "================================================================"
