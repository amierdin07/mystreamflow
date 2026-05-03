#!/bin/bash
# ==========================================
#  PPHQ Finance - Auto Installer Template
# ==========================================
set -e

echo "🚀 Memulai instalasi PPHQ Finance..."

# 1. Cek & Install Git + Build Essentials
sudo apt update && sudo apt install -y git build-essential

# 2. Cek apakah Node.js sudah terinstall
if ! command -v node &> /dev/null
then
    echo "📦 Node.js belum ada, menginstall Node v22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✅ Node.js sudah terpasang: $(node -v)"
fi

# 3. Cek & Install PM2
if ! command -v pm2 &> /dev/null
then
    echo "⚙️ Menginstall PM2..."
    sudo npm install -g pm2
fi

# 4. Install Dependencies
echo "📦 Menginstall Node Modules..."
npm install

# 5. Jalankan Aplikasi
echo "▶️ Menjalankan aplikasi dengan PM2..."
pm2 delete pphq-finance 2>/dev/null || true
pm2 start app.js --name pphq-finance
pm2 save

echo "===================================================="
echo "✅ INSTALASI SELESAI!"
echo "Aplikasi berjalan di background (PM2)."
echo "Gunakan port yang sesuai di settingan aaPanel kamu."
echo "===================================================="
