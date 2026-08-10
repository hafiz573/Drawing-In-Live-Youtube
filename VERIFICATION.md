# Panduan Verifikasi OAuth Google — Drawing In Live

Dokumen ini untuk menghilangkan layar **"Google belum memverifikasi aplikasi ini"** secara permanen.

**Kenapa layar itu muncul:** `youtube.readonly` adalah *sensitive scope*. Selama aplikasi belum
diverifikasi Google, setiap pengguna akan melihat peringatan itu, dan aplikasi berstatus *Testing*
hanya bisa dipakai maksimal 100 akun yang kamu daftarkan sebagai Test user.

**Perkiraan waktu:** persiapan 1–2 hari, review Google **2–6 minggu**. Untuk sensitive scope biasanya
lebih cepat daripada restricted scope. Selama menunggu, aplikasi tetap bisa dipakai lewat tombol
**Lanjutan** oleh Test user.

> **Blokir utama:** Google **tidak menerima `localhost`**. Kamu wajib punya domain publik ber-HTTPS
> sebelum bisa submit. Ini langkah pertama, bukan terakhir.

---

## Ceklis lengkap

### Fase 1 — Domain publik (wajib, kerjakan duluan)

- [ ] **Punya domain**, misalnya `drawinglive.app` atau subdomain seperti `live.domainkamu.com`.
- [ ] **Deploy aplikasi ke domain itu dengan HTTPS.** Opsi termurah:
  - **Railway / Render / Fly.io** — cukup `Dockerfile` yang sudah ada di repo, HTTPS otomatis.
  - **VPS + Caddy/Nginx** — reverse proxy dengan sertifikat Let's Encrypt.
  - Set env di server produksi:
    ```env
    NODE_ENV=production
    PUBLIC_ORIGIN=https://drawinglive.app
    OAUTH_REDIRECT_URI=https://drawinglive.app/auth/google/callback
    ```
    `NODE_ENV=production` menyalakan flag `Secure` pada cookie sesi — Google mengecek ini.
- [ ] **Verifikasi kepemilikan domain** di
      [Google Search Console](https://search.google.com/search-console) memakai **akun Google yang
      sama** dengan pemilik proyek Cloud. Tanpa ini, submit akan ditolak otomatis.
- [ ] Pastikan halaman-halaman ini bisa dibuka publik **tanpa login**, dari jaringan mana pun:
  - `https://domainkamu/` — homepage, menjelaskan fungsi aplikasi ✔ sudah ada
  - `https://domainkamu/privacy` — kebijakan privasi ✔ sudah ada
  - `https://domainkamu/terms` — syarat & ketentuan ✔ sudah ada

### Fase 2 — OAuth consent screen

Di [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):

- [ ] **App name:** `Drawing In Live`
- [ ] **User support email:** email yang kamu pantau
- [ ] **App logo:** PNG/JPG **120×120 px**, di bawah 1 MB, tanpa teks yang menutupi.
      Logo akan ikut direview — pakai ikon yang sama dengan favicon aplikasi.
- [ ] **Application home page:** `https://domainkamu/`
- [ ] **Application privacy policy link:** `https://domainkamu/privacy`
- [ ] **Application terms of service link:** `https://domainkamu/terms`
- [ ] **Authorized domains:** `domainkamu` (tanpa `https://`, tanpa subdomain `www`)
- [ ] **Developer contact information:** email kamu
- [ ] **Publishing status:** klik **PUBLISH APP** → ubah dari *Testing* ke **In production**.
      Selama masih *Testing*, tombol submit verifikasi tidak muncul.

### Fase 3 — Kredensial

Di **Credentials → OAuth 2.0 Client ID** milikmu:

- [ ] **Authorized JavaScript origins:** `https://domainkamu`
- [ ] **Authorized redirect URIs:** `https://domainkamu/auth/google/callback`
- [ ] Boleh menyimpan `http://localhost:3000/auth/google/callback` juga untuk development —
      Google mengizinkan localhost berdampingan, yang dilarang adalah *hanya* localhost.

### Fase 4 — Video demo (paling sering jadi penyebab penolakan)

Wajib. Unggah ke YouTube, boleh **Unlisted**, tapi **jangan Private**. Tanpa narasi pun boleh,
asalkan alurnya terlihat jelas dan tidak dipotong-potong.

Video harus memperlihatkan, berurutan:

1. **URL bar terlihat**, menampilkan `https://domainkamu` — bukan localhost.
2. Klik tombol **"Lanjutkan dengan Google"** di halaman login.
3. **Layar consent Google secara utuh**, sampai daftar scope-nya terbaca jelas —
   perbesar/zoom bagian yang menyebut akses YouTube.
4. Setelah menyetujui: dashboard terbuka, dan tunjuk dengan jelas
   **nama channel + avatar YouTube** yang muncul di pojok kanan atas.
   *Ini adalah bukti penggunaan `youtube.readonly` — bagian ini tidak boleh dilewat.*
5. **Kalau kamu ikut mengajukan scope membership:** buka **Siapa yang boleh menggambar → Member**,
   klik **Hubungkan cek member**, lalu perlihatkan status
   *"Members API tersambung. N member terbaca dari YouTube."*
6. Tutup dengan demo fungsi utamanya: buka link penonton di tab lain, gambar sesuatu,
   dan perlihatkan goresan itu muncul di overlay.

Sebutkan **OAuth Client ID** kamu di deskripsi video — reviewer mencocokkannya.

### Fase 5 — Submit

- [ ] Di OAuth consent screen, klik **PREPARE FOR VERIFICATION** / **SUBMIT FOR VERIFICATION**.
- [ ] Isi form justifikasi scope — teks siap pakai ada di bawah.
- [ ] Tempel URL video demo.
- [ ] Kirim, lalu **pantau email**. Google hampir selalu mengirim satu putaran pertanyaan susulan;
      balas dalam beberapa hari, karena tiket yang didiamkan akan ditutup dan kamu harus mengulang.

---

## Teks justifikasi scope (siap salin-tempel)

Google meminta ini dalam bahasa Inggris.

### `https://www.googleapis.com/auth/youtube.readonly`

> Drawing In Live is a real-time collaborative drawing overlay for live streamers. When a creator
> signs in, the application makes a single `youtube.channels.list?part=snippet&mine=true` call to
> read the title and thumbnail of the creator's own public YouTube channel.
>
> That channel title and avatar are displayed in three places: the creator's dashboard, the public
> drawing room that viewers open, and the room preview shown before joining. This lets viewers
> confirm they are drawing on the correct creator's canvas before they participate, which prevents
> impersonation of a channel by anyone who copies the room link.
>
> No other YouTube data is requested, read, or stored. The application never accesses videos,
> playlists, comments, analytics, subscriptions, or private channel data, and the read-only scope
> makes any modification technically impossible. The response is used immediately and only the
> public channel title, channel ID, and thumbnail URL are persisted, so the correct channel can be
> shown again on the next sign-in without repeating the API call.
>
> A narrower scope does not exist: the basic `profile` scope returns the Google account name, which
> for many creators differs from their YouTube channel name, and it returns no channel identity at
> all — which is exactly the value viewers need in order to trust the room.

### `https://www.googleapis.com/auth/youtube.channel-memberships.creator` *(hanya kalau kamu memakai mode member)*

> This scope is optional and is never requested during normal sign-in. It is requested through a
> separate, explicit incremental consent screen, and only when a creator chooses to restrict their
> drawing room to channel members.
>
> When enabled, the application calls `youtube.members.list` to obtain the channel IDs of the
> creator's current members, and compares an incoming viewer's channel ID against that set to decide
> whether the viewer is allowed to draw. The result is held in memory and cached for at most five
> minutes to limit API quota usage.
>
> The member list is never displayed, exported, downloaded, or shared, and no member identity is
> written to persistent storage. If the creator turns members-only mode off or revokes access, the
> cached list is discarded and the stored refresh token is deleted.

---

## Kalau tidak mau menunggu 2–6 minggu

Alternatif yang menghilangkan peringatan **tanpa verifikasi sama sekali**: jadikan
`youtube.readonly` opsional. Login default hanya memakai `openid`, `email`, `profile` —
semuanya non-sensitive, jadi tidak ada layar peringatan. Nama dan avatar diambil dari akun Google,
dan scope YouTube baru diminta lewat tombol terpisah di dashboard untuk kreator yang memang mau
menampilkan identitas channel-nya.

Konsekuensinya: kreator yang nama akun Google-nya berbeda dari nama channel harus menekan satu
tombol tambahan. Bilang saja kalau mau saya kerjakan — sekitar 15 menit.

Dua jalur ini juga bisa digabung: pakai skema opsional itu **sekarang** supaya pengguna langsung
mulus, sambil verifikasi tetap berjalan di latar belakang.

---

## Kesalahan yang paling sering bikin ditolak

| Masalah | Akibat |
| --- | --- |
| Domain di consent screen belum diverifikasi di Search Console | ditolak otomatis, tanpa review |
| Video demo tidak memperlihatkan layar consent | diminta kirim ulang video |
| Video demo tidak memperlihatkan data scope dipakai untuk apa | diminta kirim ulang video |
| Video di-set Private | reviewer tidak bisa membuka, tiket macet |
| Halaman privasi butuh login untuk dibuka | ditolak |
| Halaman privasi tidak menyebut nama aplikasi persis seperti di consent screen | diminta revisi |
| Tidak ada pernyataan Limited Use di halaman privasi | ditolak — ✔ ini sudah ada di `/privacy` |
| App masih berstatus *Testing* saat submit | tombol submit tidak muncul |
| Email susulan dari Google tidak dibalas | tiket ditutup, ulang dari awal |
