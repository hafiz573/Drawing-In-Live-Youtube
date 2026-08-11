# Drawing In Live

Kanvas kolaboratif real-time untuk live streamer. Penonton menggambar lewat browser
(HP atau laptop), dan setiap goresan langsung muncul di layar streaming YouTuber
lewat **Browser Source OBS** dengan latar transparan.

- **Login YouTuber:** Google OAuth, scope **read-only** (`youtube.readonly`) — hanya untuk
  menampilkan nama & avatar channel publik. Tidak ada password yang disimpan.
- **Kontrol akses:** setiap room bisa diatur **Publik** (siapa pun yang punya link) atau
  **Khusus member** (verifikasi membership YouTube).
- **Jalan di Vercel.** Realtime-nya memakai long-polling di atas Postgres, jadi tidak butuh
  WebSocket maupun server yang hidup terus. Database pakai Postgres cloud gratis (Neon/Supabase).

---

## 1. Jalankan

```bash
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# isi DATABASE_URL + SESSION_SECRET (lihat langkah 2 & 3)
npm run dev                   # atau: npm start
```

Buka <http://localhost:3000>.

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | jalankan dengan auto-reload saat file berubah |
| `npm start` | jalankan mode biasa |
| `npm test` | smoke test end-to-end |

Tabel database dibuat otomatis saat server pertama kali start — tidak ada langkah migrasi manual.

---

## 2. Database (Postgres cloud)

Pilih salah satu, dua-duanya punya paket gratis yang cukup:

### Neon — <https://neon.tech>
1. Daftar → **Create project**.
2. Di dashboard, ambil **Connection string** (yang `-pooler`, dengan `?sslmode=require`).
3. Tempel ke `.env`:
   ```env
   DATABASE_URL=postgresql://user:password@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

### Supabase — <https://supabase.com>
1. Daftar → **New project** (catat password database yang kamu buat).
2. **Project Settings → Database → Connection string → URI**, pilih mode **Transaction pooler**.
3. Ganti `[YOUR-PASSWORD]` dengan password tadi, lalu tempel ke `.env`:
   ```env
   DATABASE_URL=postgresql://postgres.xxxx:password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
   ```

Provider lain (Railway, Render, Aiven, RDS) juga jalan — apa pun yang memberi connection string
Postgres. SSL dinyalakan otomatis untuk host cloud dan dimatikan untuk `localhost`; timpa lewat
`DB_SSL` kalau perlu (`true` / `strict` / `false`).

> Database serverless bisa "tidur" saat idle. Koneksi pertama setelah nganggur mungkin butuh
> beberapa detik — server sudah menangani ini dengan retry, jadi tidak akan langsung mati.

---

## 3. Setup Google OAuth

Tanpa langkah ini tombol login tidak aktif (server tetap jalan, halaman `/auth/google`
akan menampilkan instruksi).

1. Buka [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Enabled APIs & services** → aktifkan **YouTube Data API v3**.
3. **OAuth consent screen** → isi nama aplikasi, email support, dan **cukup tambahkan scope
   non-sensitif saja**:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`

   > **Jangan deklarasikan `youtube.readonly` di sini.** Scope itu sensitif; mendeklarasikannya
   > membuat Google mewajibkan verifikasi dan menampilkan layar *"Google belum memverifikasi
   > aplikasi ini"* kepada **semua** pengguna. Aplikasi ini sengaja tidak memintanya saat login
   > biasa — lihat "Model scope" di bawah.
4. Selama status masih **Testing**, tambahkan akun Google kamu di **Test users** —
   kalau tidak, login akan ditolak Google.
5. **Create credentials → OAuth client ID → Web application**.
   Di *Authorized redirect URIs* isi **persis**:
   ```
   http://localhost:3000/auth/google/callback
   ```
6. Salin Client ID & Secret ke `.env`:
   ```env
   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxx
   OAUTH_REDIRECT_URI=http://localhost:3000/auth/google/callback
   ```
7. Restart server.

Isi juga `SESSION_SECRET` dengan string acak:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> **Deploy ke domain asli:** set `PUBLIC_ORIGIN=https://domain-kamu.com`,
> `OAUTH_REDIRECT_URI=https://domain-kamu.com/auth/google/callback` (daftarkan juga di Google
> Console), dan `NODE_ENV=production` supaya cookie sesi memakai flag `Secure`.

### Model scope

Izin diminta bertahap, tidak sekaligus di awal, supaya login biasa tidak pernah memicu layar
peringatan Google:

| Kapan | Scope | Sensitif? |
| --- | --- | --- |
| Login kreator | `openid`, `email`, `profile` | tidak |
| Kreator menekan **Hubungkan channel YouTube** di dashboard | + `youtube.readonly` | ya |
| Penonton masuk ke room **khusus member** | + `youtube.readonly` | ya |
| Kreator mengaktifkan **cek member otomatis** | + `channel-memberships.creator` | ya |

Konsekuensinya: setelah login pertama, nama dan foto diambil dari Akun Google. Kreator yang
ingin nama channel YouTube-nya tampil tinggal menekan satu tombol di dashboard.

Layar *"Google belum memverifikasi aplikasi ini"* hanya muncul pada tiga baris terakhir tabel —
bukan pada login biasa. Kalau nanti kamu ingin menghilangkannya di sana juga, aplikasi harus
diverifikasi Google; ceklis lengkapnya ada di **[VERIFICATION.md](VERIFICATION.md)**.

---

## 4. Deploy ke Vercel

Repo ini sudah berisi [`vercel.json`](vercel.json) dan [`api/index.js`](api/index.js).

1. **Vercel Dashboard → Add New → Project** → import repo `Drawing-In-Live-Youtube`.
2. **Root Directory: biarkan kosong** (`./`). Framework Preset: **Other**.
   Build Command dan Output Directory dikosongkan — semuanya diatur `vercel.json`.
3. **Environment Variables**, isi keempat ini:
   ```env
   DATABASE_URL=postgresql://...   # pakai yang ada "-pooler", lihat catatan di bawah
   SESSION_SECRET=...              # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
4. **Deploy**. Catat URL-nya, misal `https://drawing-in-live.vercel.app`.
5. Tambahkan dua env var lagi, lalu **Redeploy**:
   ```env
   PUBLIC_ORIGIN=https://drawing-in-live.vercel.app
   OAUTH_REDIRECT_URI=https://drawing-in-live.vercel.app/auth/google/callback
   ```
6. **Google Cloud Console → Credentials → OAuth client** kamu, tambahkan di
   *Authorized redirect URIs*:
   ```
   https://drawing-in-live.vercel.app/auth/google/callback
   ```
   Biarkan `http://localhost:3000/auth/google/callback` tetap ada supaya development lokal jalan.

### Dua hal yang wajib benar

**Region.** `vercel.json` mengunci fungsi ke `sin1` (Singapura) agar sedekat mungkin dengan
database Neon di `ap-southeast-1`. Kalau database kamu di region lain, ganti `regions` di
`vercel.json` — kalau fungsi dan database beda benua, tiap query menyeberang samudra dan
kanvasnya terasa berat. Di paket Hobby, region juga bisa diatur lewat
*Project Settings → Functions → Function Region*.

**Connection string.** Pakai endpoint Neon yang mengandung `-pooler`. Setiap invocation
serverless membuka koneksinya sendiri, dan endpoint langsung akan cepat kehabisan slot.
Server akan memperingatkan di log kalau ini keliru.

### Batas paket Hobby

Transport realtime memakai long-polling: satu request ditahan sampai ~20 detik, lalu client
bertanya lagi. Saat kanvas sepi, itu sekitar **3 request per menit per penonton**; saat ramai
menggambar, request kembali lebih cepat.

Kira-kira satu siaran 3 jam dengan 10 penonton aktif menghabiskan 30–60 ribu invocation,
sementara paket Hobby memberi 1 juta per bulan. Cukup untuk belasan siaran. Kalau channel
kamu tumbuh besar, pindah ke host dengan proses persisten akan jauh lebih murah —
[`render.yaml`](render.yaml) sudah disiapkan untuk itu dan kodenya jalan apa adanya.

---

## 4b. Alternatif: Render

Kode yang sama juga jalan di Render tanpa perubahan, dan di sana long-polling lebih hemat
karena tidak dihitung per-invocation. Repo berisi [`render.yaml`](render.yaml):
**New → Blueprint** → pilih repo → isi env var yang diminta → Apply.

Catatan free tier Render: service tidur setelah 15 menit tanpa trafik dan butuh ~50 detik
untuk bangun. Buka overlay 1 menit sebelum siaran supaya sudah panas.

---

## 5. Pasang overlay di OBS

1. Login → buka **Dashboard** → salin **URL overlay**.
2. Di OBS: **Sources → + → Browser**.
3. Tempel URL, lalu isi:
   - **Width / Height** = sama dengan ukuran kanvas di dashboard (default `1280 × 720`)
   - centang **Shutdown source when not visible**
   - centang **Refresh browser when scene becomes active**
4. Jangan tambahkan CSS apa pun — halaman overlay memang sudah transparan.
5. Bagikan **link penonton** (atau kode 6 huruf) ke chat.

Parameter URL overlay yang bisa dipakai:

| Query | Efek |
| --- | --- |
| `?hud=0` | sembunyikan chip status kecil di pojok kiri atas |
| `?fit=contain` | jaga rasio kanvas kalau ukuran Browser Source berbeda |

> URL overlay bersifat **rahasia** — siapa pun yang punya URL itu bisa melihat kanvas kamu.
> Kalau bocor, tekan **Reset URL** di dashboard; URL lama langsung mati.

---

## 6. Mode akses: Publik vs Member

Diatur di **Dashboard → Siapa yang boleh menggambar**.

### Publik
Penonton cukup buka link, isi nama panggilan, langsung menggambar. Tanpa login.

### Khusus member
Penonton wajib login Google (read-only juga), lalu status membership-nya dicek ke channel kamu.
Ada dua sumber data, dipilih lewat **Sumber data member**:

| Sumber | Cara kerja | Syarat |
| --- | --- | --- |
| **YouTube Members API** | Server membaca `members.list` milik channel kamu dan mencocokkan channel ID penonton. Hasilnya di-cache 5 menit. | Channel harus sudah masuk **YouTube Partner Program**, dan kamu harus menekan **Hubungkan cek member** (consent tambahan). |
| **Daftar manual** | Kamu memasukkan channel ID (`UC…`) yang boleh menggambar. | Tidak ada. Selalu bisa dipakai. |
| **Otomatis** *(default)* | Coba daftar manual dulu, lalu Members API. | — |

Kalau channel belum eligible untuk Members API, dashboard akan bilang begitu secara eksplisit
dan kamu tinggal pakai daftar manual. Mengganti mode ke **Member** saat room sedang ramai akan
langsung **mengeluarkan penonton yang bukan member**.

---

## 7. Kontrol host lainnya

Semua ada di dashboard dan berlaku seketika ke semua penonton + overlay:

- **Bekukan kanvas** — semua orang berhenti menggambar, gambar tetap tampil.
- **Hapus semua / Batal goresan terakhir**.
- **Moderasi: setujui dulu** — penonton baru harus kamu izinkan satu per satu.
- **Per penonton:** hapus gambarnya, tendang, atau blokir permanen.
- **Anti-spam:** jeda antar goresan, maksimum goresan per penonton, batas ukuran kuas.
- **Goresan memudar** setelah N detik, supaya layar tidak penuh di sesi panjang.
- **Ganti kode room** kalau link tersebar ke tempat yang tidak diinginkan.

---

## 8. Arsitektur

```
server/
  app.js         Express app: routes, OAuth, REST API, versi aset  ← dipakai lokal & Vercel
  index.js       entry lokal: buka port, tunggu DB, graceful shutdown
  db.js          Pool Postgres (+ auto-SSL), migrasi skema, semua query
  auth.js        cookie sesi (JWT), identitas viewer, state OAuth
  google.js      OAuth 2.0 + YouTube Data API (fetch, tanpa SDK)
  membership.js  gerbang publik/member + cache daftar member
  live.js        transport realtime: event log + long-polling
api/index.js     entry Vercel (mengekspor app.js)
views/           halaman HTML
public/          css, js klien, gambar (dilayani di /static)
test/smoke.js    smoke test end-to-end
```

### Cara realtime-nya bekerja

Tidak ada WebSocket, jadi tidak butuh proses yang hidup terus. Setiap perubahan jadi satu baris
di tabel `room_events`, dan klien mengikutinya lewat nomor urut:

```
penonton  ──POST /stroke──▶  strokes + room_events  ◀──GET /poll (ditahan ~20 dtk)──  overlay OBS
                                     (Postgres)                                        dashboard
                                                                                       penonton lain
```

Request `poll` ditahan sampai ada event baru, lalu langsung balas. Kalau 20 detik tidak terjadi
apa-apa, ia balas kosong dan klien bertanya lagi. Klien yang tertinggal terlalu jauh dari
riwayat akan otomatis diberi snapshot penuh, bukan potongan stream yang bolong.

Latensi terukur di mesin lokal terhadap Neon Singapura: **median 209 ms, terburuk 273 ms**,
ditambah pengelompokan titik 200 ms di sisi penonton. Siaran itu sendiri tertunda beberapa
detik, jadi penonton tidak akan merasakan selisih ini.

Koordinat goresan dikirim ternormalisasi `0..1`, sehingga penonton, dashboard, dan overlay bisa
merender ukuran berapa pun dari data yang sama.

### Batas bawaan (di `server/live.js`)

| Konstanta | Nilai | Alasan |
| --- | --- | --- |
| `MAX_STROKES_PER_ROOM` | 1200 | goresan terlama dibuang otomatis, menjaga FPS overlay |
| `MAX_POINTS_PER_STROKE` | 1200 | satu goresan tidak bisa dibikin tak terhingga |
| `MAX_POINTS_PER_BATCH` | 600 | batas ukuran satu request |
| `EVENT_RETENTION_MS` | 3 menit | seberapa jauh klien boleh tertinggal sebelum di-resync |
| `HOLD_MS` | 20 detik | lama satu request poll ditahan |

---

## 9. Test

Jalankan server dulu (`npm run dev`), lalu di terminal lain:

```bash
npm test
```

Smoke test mengecek route HTTP, alur gambar viewer → overlay, snapshot untuk overlay yang baru
join, moderasi, dan penolakan token/room/sesi palsu. Butuh satu baris creator di database.
Seed lewat SQL editor Neon/Supabase, atau langsung dari sini:

```bash
node -e "
require('dotenv').config();
const db = require('./server/db');
(async () => {
  await db.migrate();
  await db.upsertFromGoogle({
    googleSub: 'smoke-test-sub', email: 'smoke@example.com',
    displayName: 'Smoke Test Channel', channelTitle: 'Smoke Test Channel',
    channelId: 'UCsmoketestsmoketest1234', scopes: [],
  });
  const u = await db.findByRoomCode((await db.pool.query(\"SELECT room_code FROM users WHERE google_sub='smoke-test-sub'\")).rows[0].room_code);
  console.log('ROOM_CODE=' + u.roomCode);
  console.log('OVERLAY_TOKEN=' + u.overlayToken);
  await db.pool.end();
})();
"
```

Lalu jalankan smoke test dengan nilai yang dicetak:

```bash
ROOM_CODE=XXXXXX OVERLAY_TOKEN=xxxx npm test
# PowerShell: $env:ROOM_CODE="XXXXXX"; $env:OVERLAY_TOKEN="xxxx"; npm test
```

Untuk coba manual, buka `http://localhost:3000/draw/<ROOM_CODE>` dan
`http://localhost:3000/overlay/<OVERLAY_TOKEN>` di dua tab.

---

## 10. Variabel lingkungan

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `DATABASE_URL` | ya | connection string Postgres cloud |
| `SESSION_SECRET` | ya | kunci tanda tangan cookie sesi, minimal 32 karakter acak |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | untuk login | kredensial OAuth dari Google Cloud |
| `OAUTH_REDIRECT_URI` | untuk login | harus sama persis dengan yang didaftarkan di Google |
| `DB_SSL` | — | `true` / `strict` / `false`; kosongkan untuk deteksi otomatis |
| `PGPOOL_MAX` | — | maksimum koneksi database bersamaan (default `8`) |
| `PORT` | — | port server (default `3000`) |
| `NODE_ENV` | — | set `production` di server asli agar cookie `Secure` aktif |

---

## 11. Privasi

Halaman `/privacy` memuat detailnya. Ringkasnya:

- Scope Google yang diminta **read-only**; tidak bisa mengunggah, mengubah, atau menghapus apa pun.
- Penonton **tidak punya baris database** — identitasnya hanya ada di cookie bertanda tangan
  di browser mereka sendiri.
- Password tidak pernah ada; autentikasi sepenuhnya di Google.
- Refresh token hanya disimpan kalau kamu mengaktifkan cek member otomatis, dan terhapus
  sendiri begitu Google menolaknya.
