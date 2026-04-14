#!/bin/bash
set -e

# ================================================================
#  StreamFlow Auto Installer for amierdin07/mystreamflow
# ================================================================

echo "🚀 Memulai Instalasi StreamFlow..."
sleep 2

# 1. Update & Install Dependency Dasar
echo "🔄 Updating sistem dan menginstall dependency..."
sudo apt update && sudo apt upgrade -y
sudo apt install git ffmpeg nginx certbot python3-certbot-nginx -y

# 2. Install Node.js v22 (LTS Terbaru)
echo "📦 Menginstall Node.js v22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone Repository Amierdin07
echo "📥 Mengkloning repository mystreamflow..."
if [ -d "mystreamflow" ]; then
    echo "⚠️ Folder mystreamflow sudah ada, menghapus folder lama..."
    rm -rf mystreamflow
fi
git clone https://github.com/amierdin07/mystreamflow.git
cd mystreamflow

# 4. Install Module & Setup
echo "⚙️ Menginstall Node modules (ini mungkin agak lama)..."
npm install
node generate-secret.js

# 5. Setup Zona Waktu
echo "🕐 Mengatur zona waktu ke WIB (Jakarta)..."
sudo timedatectl set-timezone Asia/Jakarta

# 6. Install & Setup PM2
if ! command -v pm2 &> /dev/null; then
    echo "🚀 Menginstall PM2..."
    sudo npm install -g pm2
fi

echo "▶️ Menjalankan aplikasi dengan PM2..."
pm2 delete streamflow 2>/dev/null || true
pm2 start app.js --name streamflow
pm2 save
pm2 startup | tail -1 | bash || true

# 7. Selesai
clear
echo "================================================================"
echo "✅ INSTALASI SELESAI!"
echo "================================================================"
IP_VPS=$(curl -s ifconfig.me)
echo "Aplikasi berjalan di: http://$IP_VPS:7575"
echo ""
echo "Langkah berikutnya:"
echo "1. Buka link di atas di browser."
echo "2. Setup akun Admin."
echo "3. Masukkan Client ID & Secret YouTube di menu Settings."
echo "================================================================"
