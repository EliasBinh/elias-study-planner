/**
 * Tool tự động theo dõi và tải PDF từ ClassIn Desktop App
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9222;
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');

console.log('='.repeat(50));
console.log('🔍 CLASSIN PDF AUTO-SNIFFER ĐANG CHẠY');
console.log(`📁 Thư mục lưu PDF: ${DOWNLOAD_DIR}`);
console.log('='.repeat(50));
console.log('Đang chờ bạn mở bài thi / bài tập trong app ClassIn...\n');

const downloaded = new Set();

function getTargets() {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

function downloadPdf(url, filename) {
  if (downloaded.has(url)) return;
  downloaded.add(url);

  console.log(`\n🎯 PHÁT HIỆN FILE PDF: ${filename}`);
  console.log(`🔗 Link: ${url}`);
  console.log('⏳ Đang tải...');

  const cleanName = filename.replace(/[<>:"/\\|?*]/g, '_').trim();
  const filePath = path.join(DOWNLOAD_DIR, cleanName.endsWith('.pdf') ? cleanName : `${cleanName}.pdf`);

  const client = url.startsWith('https') ? https : http;
  client.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      return downloadPdf(res.headers.location, filename);
    }
    const fileStream = fs.createWriteStream(filePath);
    res.pipe(fileStream);
    fileStream.on('finish', () => {
      fileStream.close();
      console.log(`✅ ĐÃ TẢI XONG VÀO DOWNLOADS: ${path.basename(filePath)}\n`);
    });
  }).on('error', (err) => {
    console.error(`❌ Lỗi tải: ${err.message}`);
  });
}

// Định kỳ quét các trang đang mở trong ClassIn
async function poll() {
  const targets = await getTargets();
  for (const t of targets) {
    const url = t.url || '';
    // Nếu URL của target chứa link PDF trực tiếp
    if (url.toLowerCase().includes('.pdf')) {
      const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'ClassIn_Homework.pdf';
      downloadPdf(url, name);
    }
  }
}

setInterval(poll, 1500);
