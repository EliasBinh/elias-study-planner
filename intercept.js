/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   CLASSIN PDF INTERCEPTOR - CDP Mode                     ║
 * ║                                                          ║
 * ║   Kết nối trực tiếp vào Classin Desktop App              ║
 * ║   thông qua Chrome DevTools Protocol                     ║
 * ║                                                          ║
 * ║   Cách dùng:                                             ║
 * ║   1. Tắt Classin Desktop App hoàn toàn                   ║
 * ║   2. Chạy script này                                     ║
 * ║   3. Script sẽ mở lại Classin với debug mode             ║
 * ║   4. Dùng Classin bình thường, PDF tự tải về             ║
 * ╚══════════════════════════════════════════════════════════╝
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const OUTPUT_DIR = path.join(__dirname, 'downloads');
const DEBUG_PORT = 9222;

// Track downloads
const downloadedUrls = new Set();
let downloadCount = 0;

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function extractFilename(url, headers = {}) {
  const disposition = headers['content-disposition'];
  if (disposition) {
    const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";\n]+)/i);
    if (match) {
      try { return sanitizeFilename(decodeURIComponent(match[1])); } catch { return sanitizeFilename(match[1]); }
    }
  }
  try {
    const urlObj = new URL(url);
    const filename = path.basename(urlObj.pathname);
    if (filename && filename.includes('.')) return sanitizeFilename(decodeURIComponent(filename));
  } catch {}
  return `classin_pdf_${Date.now()}.pdf`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Find ClassIn.exe path
 */
function findClassInExe() {
  const possiblePaths = [
    'C:\\Program Files (x86)\\ClassIn\\ClassIn.exe',  // Confirmed path on this machine
    'C:\\Program Files\\ClassIn\\ClassIn.exe',
    path.join(process.env.LOCALAPPDATA || '', 'ClassIn', 'ClassIn.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ClassIn', 'ClassIn.exe'),
    path.join(process.env.APPDATA || '', 'ClassIn', 'ClassIn.exe'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  // Try to find via registry or where command
  try {
    const result = execSync('where ClassIn.exe 2>nul', { encoding: 'utf-8' }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {}

  // Try PowerShell search
  try {
    const result = execSync(
      'powershell -Command "Get-ChildItem -Path \'C:\\Program Files\',\'C:\\Program Files (x86)\',$env:LOCALAPPDATA,$env:APPDATA -Recurse -Filter ClassIn.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"',
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    if (result) return result;
  } catch {}

  return null;
}

/**
 * Kill existing ClassIn processes
 */
function killClassIn() {
  try {
    execSync('taskkill /f /im ClassIn.exe 2>nul', { encoding: 'utf-8' });
    console.log('   ✅ Đã tắt ClassIn');
  } catch {
    console.log('   ℹ️  ClassIn chưa chạy');
  }
}

/**
 * Check if CDP endpoint is available
 */
function checkCDP(port) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Wait for CDP to become available
 */
async function waitForCDP(port, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const info = await checkCDP(port);
    if (info) return info;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

/**
 * Setup PDF interception on a CDP browser
 */
async function setupInterception(browser) {
  const contexts = browser.contexts();
  
  for (const context of contexts) {
    for (const page of context.pages()) {
      await setupPageInterception(page);
    }
    
    context.on('page', async (page) => {
      await setupPageInterception(page);
    });
  }

  browser.on('context', async (context) => {
    for (const page of context.pages()) {
      await setupPageInterception(page);
    }
    context.on('page', async (page) => {
      await setupPageInterception(page);
    });
  });
}

async function setupPageInterception(page) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const status = response.status();
      const headers = response.headers();

      if (downloadedUrls.has(url)) return;
      if (status !== 200) return;

      const contentType = headers['content-type'] || '';
      const urlLower = url.toLowerCase();

      const isPdf = (
        contentType.includes('application/pdf') ||
        (contentType.includes('application/octet-stream') && urlLower.includes('.pdf')) ||
        urlLower.endsWith('.pdf') ||
        urlLower.match(/\.pdf[?#]/)
      );

      // Also check cloud storage for hidden PDFs
      const isCloudStorage = [
        'oss-cn-', 'aliyuncs.com', 's3.amazonaws.com',
        'cos.ap-', 'myqcloud.com', 'cdn.eeo.cn',
        'res.eeo.cn', 'file.eeo.cn', 'storage.eeo.cn',
      ].some(p => url.includes(p));

      if (isPdf || (isCloudStorage && contentType.includes('octet-stream'))) {
        try {
          const buffer = await response.body();
          
          if (buffer.length < 100) return;
          
          const header = buffer.slice(0, 5).toString();
          if (!header.startsWith('%PDF')) return;

          downloadedUrls.add(url);
          const filename = extractFilename(url, headers);

          let outputPath = path.join(OUTPUT_DIR, filename);
          let counter = 1;
          while (fs.existsSync(outputPath)) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            outputPath = path.join(OUTPUT_DIR, `${base} (${counter})${ext}`);
            counter++;
          }

          fs.writeFileSync(outputPath, buffer);
          downloadCount++;

          const savedFilename = path.basename(outputPath);
          console.log(`\n${'═'.repeat(50)}`);
          console.log(`📥 PDF ĐÃ TẢI THÀNH CÔNG!`);
          console.log(`   📎 File: ${savedFilename}`);
          console.log(`   📏 Kích thước: ${formatSize(buffer.length)}`);
          console.log(`   📁 Lưu tại: ${outputPath}`);
          console.log(`   📊 Tổng đã tải: ${downloadCount} file`);
          console.log(`${'═'.repeat(50)}\n`);
        } catch (err) {
          // Skip response body errors
        }
      }
    } catch (err) {
      // Skip general errors
    }
  });
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║       📚 CLASSIN PDF INTERCEPTOR - CDP Mode                  ║
║       Kết nối trực tiếp vào Classin Desktop App              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));

  console.log('🔧 Chọn phương pháp:');
  console.log('   [1] Tự động: Tắt → Mở lại Classin với debug mode (khuyến nghị)');
  console.log('   [2] Thủ công: Kết nối vào Classin đang chạy (cần mở debug port)\n');

  const method = (await ask('👉 Chọn (1/2): ')) || '1';
  rl.close();

  let browser;

  if (method === '1') {
    // Auto mode: restart ClassIn with debug port
    console.log('\n🔍 Đang tìm ClassIn.exe...');
    const classinPath = findClassInExe();

    if (!classinPath) {
      console.log('❌ Không tìm thấy ClassIn.exe!');
      console.log('   Hãy chạy "node download.js" để dùng phương pháp browser thay thế.');
      process.exit(1);
    }

    console.log(`   ✅ Tìm thấy: ${classinPath}`);

    console.log('\n⚠️  Đang tắt ClassIn...');
    killClassIn();
    
    // Wait a bit for process to fully terminate
    await new Promise(r => setTimeout(r, 2000));

    console.log(`\n🚀 Đang mở lại ClassIn với debug port ${DEBUG_PORT}...`);
    
    // Launch ClassIn with remote debugging enabled
    const classinProcess = spawn(classinPath, [
      `--remote-debugging-port=${DEBUG_PORT}`,
    ], {
      detached: true,
      stdio: 'ignore',
    });
    classinProcess.unref();

    console.log('   ⏳ Đang chờ ClassIn khởi động...');
    const cdpInfo = await waitForCDP(DEBUG_PORT, 30000);

    if (!cdpInfo) {
      console.log('   ❌ Không thể kết nối tới ClassIn qua CDP.');
      console.log('   ClassIn có thể không hỗ trợ --remote-debugging-port.');
      console.log('   Hãy thử "node download.js" để dùng phương pháp browser.\n');
      process.exit(1);
    }

    console.log(`   ✅ Đã kết nối! Browser: ${cdpInfo.Browser || 'Unknown'}`);

    // Connect Playwright to the running ClassIn instance
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);

  } else {
    // Manual mode: connect to existing instance
    console.log(`\n📋 Hãy mở ClassIn với flag: --remote-debugging-port=${DEBUG_PORT}`);
    console.log('   Hoặc thêm flag này vào shortcut ClassIn.\n');
    console.log('   ⏳ Đang chờ kết nối...');

    const cdpInfo = await waitForCDP(DEBUG_PORT, 60000);
    if (!cdpInfo) {
      console.log('   ❌ Không thể kết nối. Hãy đảm bảo ClassIn đã mở với debug port.');
      process.exit(1);
    }

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  }

  console.log('\n✅ ĐÃ KẾT NỐI VÀO CLASSIN!');
  
  // Setup interception
  await setupInterception(browser);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👁️  ĐANG GIÁM SÁT TẤT CẢ TRAFFIC...');
  console.log('   Mở homework/bài thi trong ClassIn');
  console.log('   PDF sẽ tự động được tải về: downloads/');
  console.log('   Nhấn Ctrl+C khi muốn dừng');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Handle cleanup
  process.on('SIGINT', async () => {
    console.log(`\n\n📊 TỔNG KẾT: Đã tải ${downloadCount} file PDF`);
    console.log(`📁 Thư mục: ${OUTPUT_DIR}\n`);
    
    try {
      await browser.close();
    } catch {}
    
    process.exit(0);
  });

  // Handle browser disconnect
  browser.on('disconnected', () => {
    console.log('\n⚠️  ClassIn đã đóng. Kết thúc giám sát.');
    console.log(`📊 Đã tải: ${downloadCount} file PDF`);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
