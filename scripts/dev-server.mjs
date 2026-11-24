// שרת פיתוח מקומי: מגיש את public/ ומריץ את פונקציות השרת שב-api/, כמו Vercel.
// הגדרות נקראות מקובץ .env.local (לא נשמר ב-git):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SERVER_SECRET, DEMO_LOGIN=1
// הרצה: npm run dev   →   http://localhost:3000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const PORT = Number(process.env.PORT || 3000);

const envFile = path.join(root, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const api = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const file = path.join(root, 'api', `${api[1]}.js`);
      if (!existsSync(file)) { res.writeHead(404).end(); return; }
      const mod = await import(pathToFileURL(file).href);
      await mod.default(req, res);
      return;
    }
    let file = path.normalize(path.join(pub, decodeURIComponent(url.pathname)));
    if (!file.startsWith(pub)) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith('/') || !existsSync(file)) file = path.join(pub, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
