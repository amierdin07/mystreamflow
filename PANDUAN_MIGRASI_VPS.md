# Panduan Migrasi StreamFlow ke VPS Baru

Dokumen ini berisi langkah-langkah untuk memindahkan aplikasi StreamFlow dari VPS lama ke VPS baru tanpa kehilangan data.

## Langkah 1: Backup Data di VPS Lama

1. Masuk ke folder aplikasi:
   ```bash
   cd ~/mystreamflow
   ```
2. Jalankan script backup otomatis:
   ```bash
   bash scripts/backup.sh
   ```
3. Script ini akan menghasilkan file `.zip` (misal: `backup_streamflow_20260420.zip`). Catat nama file ini.

## Langkah 2: Instalasi di VPS Baru

1. Clone repository dan jalankan installer:
   ```bash
   git clone https://github.com/amierdin07/mystreamflow.git
   cd mystreamflow
   bash install.sh
   ```
2. Pastikan instalasi selesai dan aplikasi berjalan (cek dengan `pm2 status`).

## Langkah 3: Transfer dan Restore Data

Di **VPS BARU**, jalankan perintah berikut untuk menarik data dari VPS lama:

1. Tarik file backup (Ganti `IP_VPS_LAMA` dan `NAMA_FILE`):
   ```bash
   scp root@IP_VPS_LAMA:~/mystreamflow/NAMA_FILE.zip .
   ```
2. Ekstrak data backup:
   ```bash
   unzip -o NAMA_FILE.zip
   ```
3. Restart aplikasi agar data baru terbaca:
   ```bash
   pm2 restart streamflow
   ```

## Troubleshooting

- **Gagal SCP:** Pastikan port 22 (SSH) di VPS lama terbuka dan kamu punya password/akses root.
- **Database Error:** Pastikan aplikasi sudah dimatikan (`pm2 stop streamflow`) sebelum melakukan backup/restore untuk menghindari data korup.
- **File Upload Hilang:** Pastikan folder `public/uploads` ikut terkompres di dalam file `.zip`.

---
*Dibuat pada: 2026-04-20*
