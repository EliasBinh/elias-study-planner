import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';

const BASE_10SAT = path.join(os.homedir(), 'Downloads', '10SAT');
const VERBAL_DIR = path.join(BASE_10SAT, 'VERBAL');
const MATH_DIR = path.join(BASE_10SAT, 'MATH');

function fetchFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://b1s-cdn.eeo.cn/'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(destPath); });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

function cleanBaseName(filename = '') {
  let base = filename;
  let prev = '';
  while (base !== prev) {
    prev = base;
    base = base
      .replace(/^\[Done\]\s*/i, '')
      .replace(/^\[\d{1,2}[.-]\d{1,2}\]\s*/i, '')
      .replace(/^\[Hạn\s*\d{1,2}[.-]\d{1,2}\]\s*/i, '')
      .replace(/^Chưa rõ\s*/i, '')
      .replace(/^\[(MATH|VERBAL|Math|Verbal)\]\s*/i, '')
      .trim();
  }
  if (!base.toLowerCase().endsWith('.pdf')) base += '.pdf';
  return base;
}

function formatFilename(baseName, deadlineTag, subject, isDone = false) {
  const clean = cleanBaseName(baseName);
  const subj = subject.toLowerCase() === 'math' ? 'Math' : 'Verbal';
  const tag = (deadlineTag || '[17.10]').replace(/Hạn\s*/i, '').replace('-', '.');
  let result = `${tag} [${subj}] ${clean}`;
  if (isDone) result = `[Done] ${result}`;
  return result.replace(/[<>:"/\\|?*]/g, '_').trim();
}

async function run() {
  const dbPath = path.join(process.cwd(), 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const missing = db.items.filter(i => i.url && (!i.localPath || !fs.existsSync(i.localPath)));
  console.log(`Downloading ${missing.length} missing files...`);
  
  for (const item of missing) {
    const isMath = (item.subject || '').toUpperCase() === 'MATH';
    const destDir = isMath ? MATH_DIR : VERBAL_DIR;
    const tag = item.deadlineTag || (isMath ? '[21.10]' : '[17.10]');
    const name = formatFilename(item.title || item.filename, tag, isMath ? 'Math' : 'Verbal', item.isDone);
    const destPath = path.join(destDir, name);
    console.log(`[Downloading] ${name}...`);
    try {
      await fetchFile(item.url, destPath);
      item.localPath = destPath;
      item.filename = name;
      item.downloaded = true;
      console.log(`[Success] Saved to ${destPath}`);
    } catch (e) {
      console.error(`[Error] Failed to download ${name}:`, e.message);
    }
  }

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  console.log('Updated database.json successfully!');
}

run();
