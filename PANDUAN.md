# 🤖 Telegram File-Store Bot (Tanpa Database)

Bot penyimpan file dengan deep link ter-encode. Arsitektur: **1 bot + 1 channel storage (private) + 1 channel public** (opsional untuk force subscribe). Tanpa database — `message_id` channel storage adalah "database"-nya.

## Cara Kerja

1. Admin upload file ke channel storage
2. Bot otomatis reply dengan link: `t.me/botmu?start=getfile_XXXX`
3. Admin copy link → post di channel public
4. User klik link → bot kirim file (setelah cek join channel, kalau force sub aktif)

Payload `XXXX` = base64url dari (`message_id` × `SECRET`), jadi tidak bisa ditebak dengan mengubah-ubah angka.

## Langkah Setup

### 1. Siapkan bot & channel

- Bot sudah ada dari @BotFather → catat **token**-nya
- Jadikan bot sebagai **admin di channel storage** (minimal izin "Post Messages")
- Kalau mau force subscribe: jadikan bot **admin di channel public** juga (butuh izin apa pun, yang penting admin, supaya bisa `getChatMember`)

### 2. Cari ID channel storage

Cara paling gampang:
1. Forward salah satu pesan dari channel storage ke bot **@userinfobot** atau **@getidsbot**
2. Catat ID-nya, formatnya seperti `-1001234567890`

### 3. Deploy ke Vercel

```bash
cd telebot-filestore
vercel deploy --prod
```

Atau push ke GitHub lalu import di dashboard Vercel.

### 4. Isi Environment Variables (di dashboard Vercel → Settings → Environment Variables)

| Nama | Contoh | Keterangan |
|------|--------|------------|
| `BOT_TOKEN` | `123456:ABC-DEF...` | Token dari BotFather |
| `BOT_USERNAME` | `asusiIabot` | Username bot **tanpa @** |
| `STORAGE_CHANNEL_ID` | `-1001234567890` | ID channel storage |
| `SECRET` | `7919` | Angka rahasia bebas (jangan diubah setelah link tersebar!) |
| `FORCE_SUB_CHANNEL` | `@channelpublikmu` | Kosongkan kalau tidak pakai force sub |

Setelah isi env, **redeploy** sekali agar env terbaca.

### 5. Pasang webhook

Buka URL ini di browser (ganti token & domain):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://NAMA-PROJECT.vercel.app/api/webhook&allowed_updates=["message","channel_post"]
```

Kalau muncul `"ok":true` berarti sukses.

> `allowed_updates` wajib menyertakan `channel_post`, kalau tidak bot tidak akan menerima notifikasi upload di channel storage.

### 6. Tes

1. Upload file apa pun ke channel storage → bot harus reply dengan link dalam 1-2 detik
2. Klik link itu dari akun lain → file terkirim ke chat pribadi

## Catatan Penting

- **Jangan ganti `SECRET`** setelah link tersebar — semua link lama jadi tidak valid.
- **Jangan hapus file di channel storage** — link-nya jadi mati (`File tidak ditemukan`).
- `protect_content: true` di kode bisa diaktifkan kalau mau user tidak bisa forward/save file.
- Batas Vercel free: eksekusi 10 detik/request — cukup banget karena `copyMessage` cuma butuh <1 detik (file tidak lewat server kita, murni antar server Telegram).
- Kalau bot tidak merespons upload di storage: cek lagi `allowed_updates` di setWebhook dan pastikan bot benar-benar admin.

## Troubleshooting

| Gejala | Penyebab umum |
|--------|---------------|
| Bot diam saat upload ke storage | `channel_post` tidak ada di `allowed_updates`, atau `STORAGE_CHANNEL_ID` salah |
| "Link tidak valid" padahal benar | `SECRET` di env beda dengan saat link dibuat |
| "File tidak ditemukan" | Pesan aslinya sudah dihapus dari channel storage |
| Force sub selalu lolos | Bot bukan admin di channel public |
