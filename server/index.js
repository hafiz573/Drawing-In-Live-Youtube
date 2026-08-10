'use strict';

/**
 * Local / long-running host entry point.
 * On Vercel the same Express app is exported from `api/index.js` instead.
 */

require('dotenv').config();

const http = require('http');
const store = require('./db');
const google = require('./google');
const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer(app);

// Long-polling holds a request open for ~20s; the default 2-minute socket
// timeout is fine, but be explicit so a proxy in front doesn't get surprised.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

async function start() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('\n  ✕ DATABASE_URL belum diisi.\n');
    console.error('    Buat database Postgres gratis di neon.tech atau supabase.com,');
    console.error('    salin connection string-nya ke DATABASE_URL di file .env,');
    console.error('    lalu jalankan lagi. Detailnya ada di README.md bagian "Database".\n');
    process.exit(1);
  }

  await store.waitForDatabase();
  await store.migrate();
  console.log('[db] Postgres tersambung, skema siap.');

  // A port clash is the most common startup failure; an unhandled 'error' event
  // would otherwise dump a stack trace that buries the actual cause.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✕ Port ${PORT} sudah dipakai proses lain.\n`);
      console.error('    Kemungkinan server ini masih jalan di terminal lain.');
      console.error('    Tutup dengan Ctrl+C di terminal itu, atau cari & hentikan prosesnya:\n');
      console.error(`      Windows : netstat -ano | findstr :${PORT}   lalu   taskkill /PID <pid> /F`);
      console.error(`      macOS   : lsof -ti :${PORT} | xargs kill\n`);
      console.error('    Atau jalankan di port lain:  PORT=3001 npm start');
      console.error('    (PowerShell:  $env:PORT="3001"; npm start)\n');
    } else {
      console.error('\n[app] server error:', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Drawing In Live  →  http://localhost:${PORT}`);
    if (!google.isConfigured()) {
      console.log('  ⚠  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi — login Google nonaktif.');
      console.log('     Ikuti langkah di README.md bagian "Setup Google OAuth".\n');
    } else {
      console.log(`  Redirect URI: ${process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`}\n`);
    }
  });
}

function shutdown(signal) {
  console.log(`\n[app] ${signal} diterima, menutup koneksi…`);
  server.close(() => {
    store.pool.end().finally(() => process.exit(0));
  });
  // Don't let a held long-poll keep the process alive forever.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[app] gagal start:', err.message);
  process.exit(1);
});
