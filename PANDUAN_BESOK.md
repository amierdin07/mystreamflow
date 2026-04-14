# Panduan Final Setup Streamflow & Google OAuth

*Halo! File ini sengaja aku buat dan simpan otomatis di dalam folder kerjamu agar kamu tidak takut kehilangan jejak percakapan kita hari ini. Besok kamu cukup buka file ini.*

---

## 1. Perintah Wajib di VPS (PuTTY)
Jika sewaktu-waktu server mati atau minta di-restart, posisimu harus menjadi `root` (`sudo su`) lalu masuk ke folder:
```bash
cd /www/wwwroot/streamflow
```

**Perintah yang berhasil kita jalankan hari ini:**
```bash
# 1. Memperbaiki Database SQLite (GLIBC Error):
npm rebuild sqlite3 --build-from-source

# 2. Membuat file .env / Kunci Rahasia Cepat:
node generate-secret.js

# 3. Menghidupkan & Mengamankan 24 Jam:
pm2 restart streamflow
pm2 save
```

---

## 2. Setting Wajib di aaPanel
Agar aplikasi membaca HTTPS dengan sempurna (tidak diblokir Google):
1. Masuk menu **Website** > Klik domain `pphqfinance.web.id`
2. Langsung ke menu **Reverse proxy** > Temukan tombol biru/teks **Conf**.
3. *Copy* kode sebaris di bawah ini:
   ```nginx
   proxy_set_header X-Forwarded-Proto https;
   ```
4. *Paste* tepat di sebelah bawah tulisan `proxy_set_header Host $host;` lalu **Save**.

---

## 3. Tahap Akhir Google Cloud (Agenda Besok)
1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Masuk menu **Google Auth Platform** > menu **Clients**.
3. Edit Client yang tadi, pastikan bagian bawah (*Authorized redirect URIs*) tersisa 1 buah tautan super bersih yang WAJIB pakai `https://`:
   `https://pphqfinance.web.id/auth/youtube/callback`
   *(Jika ada link HTTP bodong yang tanpa S, hapus saja).*
4. Salin **Client ID** & **Client Secret** ke halaman web Streamflow.
5. Kalau status aplikasinya di *Audience* masih berlabel "Testing", ingat **wajib mendaftarkan email YouTube-mu di bagian Test Users**.

Selamat melanjutkan besok!
