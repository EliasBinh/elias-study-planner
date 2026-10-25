/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          CLASSIN PDF DOWNLOADER v1.0                     ║
 * ║   Tự động tải PDF homework từ Classin                    ║
 * ║                                                          ║
 * ║   Cách hoạt động:                                        ║
 * ║   1. Mở trình duyệt Chromium với network interceptor     ║
 * ║   2. Bạn đăng nhập vào Classin                          ║
 * ║   3. Mở homework/bài thi                                ║
 * ║   4. Tool tự động bắt và lưu file PDF                   ║
 * ╚══════════════════════════════════════════════════════════╝
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OUTPUT_DIR = path.join(__dirname, 'downloads');
const SESSION_DIR = path.join(__dirname, '.session');

// Classin related domains
const CLASSIN_DOMAINS = [
  'eeo.cn',
  'classin.com',
  'classin.vn',
];

// Track downloaded files to avoid duplicates
const downloadedUrls = new Set();
let downloadCount = 0;

/**
 * Sanitize filename - remove invalid characters
 */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

/**
 * Extract filename from URL or Content-Disposition header
 */
function extractFilename(url, headers) {
  // Try Content-Disposition header first
  const disposition = headers['content-disposition'];
  if (disposition) {
    const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";\n]+)/i);
    if (match) {
      try {
        return sanitizeFilename(decodeURIComponent(match[1]));
      } catch {
        return sanitizeFilename(match[1]);
      }
    }
  }

  // Try URL
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = path.basename(pathname);
    if (filename && filename.includes('.')) {
      return sanitizeFilename(decodeURIComponent(filename));
    }
  } catch {}

  // Generate timestamp-based name
  return `classin_pdf_${Date.now()}.pdf`;
}

/**
 * Check if URL is related to Classin
 */
function isClassinUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return CLASSIN_DOMAINS.some(d => hostname.includes(d));
  } catch {
    return false;
  }
}

/**
 * Check if response is a PDF
 */
function isPdfResponse(url, headers) {
  const contentType = headers['content-type'] || '';
  const urlLower = url.toLowerCase();
  
  return (
    contentType.includes('application/pdf') ||
    contentType.includes('application/octet-stream') && urlLower.includes('.pdf') ||
    urlLower.endsWith('.pdf') ||
    urlLower.includes('.pdf?') ||
    urlLower.includes('/pdf/') && contentType.includes('octet-stream')
  );
}

/**
 * Format file size
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Create readline interface for user input
 */
function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

/**
 * Print banner
 */
function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║       📚 CLASSIN PDF DOWNLOADER v1.0                         ║
║       Tự động tải PDF homework từ Classin                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
}

/**
 * Print instructions
 */
function printInstructions() {
  console.log(`
📋 HƯỚNG DẪN SỬ DỤNG:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1️⃣  Trình duyệt Chromium sẽ mở ra
  2️⃣  Đăng nhập vào tài khoản Classin của bạn
  3️⃣  Vào phần Homework / Todo / Bài thi
  4️⃣  Mở từng bài homework có PDF
  5️⃣  Tool sẽ TỰ ĐỘNG bắt và tải PDF về thư mục downloads/

  💡 Tips:
     - Mở nhiều homework liên tiếp, tool sẽ tải tất cả
     - Kiểm tra terminal này để xem file đã tải
     - Nhấn Ctrl+C khi đã tải xong

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}

/**
 * Main function
 */
async function main() {
  printBanner();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Ensure session directory exists (for persistent login)
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const rl = createPrompt();

  console.log('🔧 Chế độ hoạt động:');
  console.log('   [1] Mở Classin Web - Đăng nhập và tải PDF (mặc định)');
  console.log('   [2] Chế độ giám sát - Bắt PDF từ BẤT KỲ trang nào bạn mở');
  console.log('   [3] Chế độ nhanh - Chỉ cần paste URL PDF để tải\n');

  const modeInput = await ask(rl, '👉 Chọn chế độ (1/2/3): ');
  const mode = modeInput || '1';

  rl.close();

  if (mode === '3') {
    await quickDownloadMode();
    return;
  }

  printInstructions();

  console.log('🚀 Đang khởi động trình duyệt...\n');

  // Launch browser with persistent context (saves login state)
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
    ignoreHTTPSErrors: true,
  });

  // Track all PDF-related network requests
  const interceptedFiles = [];

  // Setup interception for all pages (including new tabs/popups)
  async function setupPageInterception(page) {
    // Listen for all responses
    page.on('response', async (response) => {
      try {
        const url = response.url();
        const status = response.status();
        const headers = response.headers();

        // Skip if already downloaded
        if (downloadedUrls.has(url)) return;

        // Check if this is a PDF
        if (status === 200 && isPdfResponse(url, headers)) {
          downloadedUrls.add(url);
          
          const filename = extractFilename(url, headers);
          console.log(`\n🔍 PDF phát hiện: ${filename}`);
          console.log(`   URL: ${url.substring(0, 100)}...`);

          try {
            const buffer = await response.body();
            
            if (buffer.length < 100) {
              console.log(`   ⚠️  File quá nhỏ (${buffer.length} bytes), bỏ qua.`);
              return;
            }

            // Verify it's actually a PDF (check magic bytes)
            const header = buffer.slice(0, 5).toString();
            if (!header.startsWith('%PDF')) {
              console.log(`   ⚠️  Không phải file PDF thật, bỏ qua.`);
              return;
            }

            // Save the file
            let outputPath = path.join(OUTPUT_DIR, filename);
            
            // Handle filename conflicts
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
            console.log(`   ✅ ĐÃ TẢI: ${savedFilename} (${formatSize(buffer.length)})`);
            console.log(`   📁 Lưu tại: ${outputPath}`);
            console.log(`   📊 Tổng cộng đã tải: ${downloadCount} file\n`);

            interceptedFiles.push({
              filename: savedFilename,
              size: buffer.length,
              url: url,
              path: outputPath,
              time: new Date().toLocaleString('vi-VN'),
            });
          } catch (err) {
            console.log(`   ❌ Lỗi tải: ${err.message}`);
          }
        }

        // Also check for cloud storage URLs that might serve PDFs
        // (Aliyun OSS, AWS S3, Tencent Cloud, etc.)
        const cloudPatterns = [
          'oss-cn-', 'aliyuncs.com',     // Aliyun OSS
          's3.amazonaws.com', 's3-',      // AWS S3
          'cos.ap-', 'myqcloud.com',      // Tencent Cloud
          'cdn.eeo.cn',                   // Classin CDN
          'res.eeo.cn',                   // Classin resources
          'file.eeo.cn',                  // Classin files
        ];

        const isCloudStorage = cloudPatterns.some(p => url.includes(p));
        
        if (status === 200 && isCloudStorage && !downloadedUrls.has(url)) {
          const contentType = headers['content-type'] || '';
          const contentLength = parseInt(headers['content-length'] || '0');
          
          // Check if it might be a PDF (large binary file from cloud storage)
          if (contentType.includes('octet-stream') && contentLength > 10000) {
            try {
              const buffer = await response.body();
              const header = buffer.slice(0, 5).toString();
              
              if (header.startsWith('%PDF')) {
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
                console.log(`\n🔍 PDF phát hiện từ cloud storage!`);
                console.log(`   ✅ ĐÃ TẢI: ${savedFilename} (${formatSize(buffer.length)})`);
                console.log(`   📁 Lưu tại: ${outputPath}`);
                console.log(`   📊 Tổng cộng đã tải: ${downloadCount} file\n`);

                interceptedFiles.push({
                  filename: savedFilename,
                  size: buffer.length,
                  url: url,
                  path: outputPath,
                  time: new Date().toLocaleString('vi-VN'),
                });
              }
            } catch (err) {
              // Silently skip errors for cloud storage checks
            }
          }
        }
      } catch (err) {
        // Silently skip response errors
      }
    });

    // Also intercept download events
    page.on('download', async (download) => {
      try {
        const suggestedFilename = download.suggestedFilename();
        if (suggestedFilename.toLowerCase().endsWith('.pdf')) {
          const outputPath = path.join(OUTPUT_DIR, sanitizeFilename(suggestedFilename));
          await download.saveAs(outputPath);
          downloadCount++;
          console.log(`\n📥 Download phát hiện!`);
          console.log(`   ✅ ĐÃ TẢI: ${suggestedFilename}`);
          console.log(`   📁 Lưu tại: ${outputPath}`);
          console.log(`   📊 Tổng cộng đã tải: ${downloadCount} file\n`);
        }
      } catch (err) {
        console.log(`   ❌ Lỗi download: ${err.message}`);
      }
    });
  }

  // Setup interception for existing pages
  for (const page of browser.pages()) {
    await setupPageInterception(page);
  }

  // Setup interception for new pages
  browser.on('page', async (page) => {
    await setupPageInterception(page);
  });

  // Navigate to Classin based on mode
  const page = browser.pages()[0] || await browser.newPage();

  if (mode === '1') {
    console.log('🌐 Đang mở Classin...\n');
    try {
      await page.goto('https://www.classin.com', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
    } catch (err) {
      console.log('⚠️  Không thể mở classin.com, thử classin.vn...');
      try {
        await page.goto('https://www.classin.vn', { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
      } catch (err2) {
        console.log('⚠️  Không thể kết nối. Hãy tự điều hướng trong trình duyệt.');
      }
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👁️  ĐANG GIÁM SÁT... Mở homework để tải PDF');
  console.log('   Nhấn Ctrl+C khi muốn dừng');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Keep running until user presses Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n\n📊 TỔNG KẾT:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    if (interceptedFiles.length > 0) {
      console.log(`\n✅ Đã tải ${interceptedFiles.length} file PDF:\n`);
      for (const file of interceptedFiles) {
        console.log(`   📎 ${file.filename} (${formatSize(file.size)})`);
        console.log(`      Thời gian: ${file.time}`);
        console.log(`      Lưu tại: ${file.path}\n`);
      }
    } else {
      console.log('\n⚠️  Chưa tải được file nào.');
      console.log('   Hãy đảm bảo bạn đã mở homework có chứa PDF.');
    }
    
    console.log(`\n📁 Thư mục downloads: ${OUTPUT_DIR}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    await browser.close();
    process.exit(0);
  });

  // Keep the script alive
  await new Promise(() => {});
}

/**
 * Quick download mode - paste URL directly
 */
async function quickDownloadMode() {
  const rl = createPrompt();
  
  console.log('\n📋 CHẾ ĐỘ NHANH - Paste URL PDF để tải');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   Paste URL từ DevTools (F12 > Network > tìm request PDF)');
  console.log('   Gõ "quit" để thoát\n');

  const https = require('https');
  const http = require('http');

  while (true) {
    const url = await ask(rl, '🔗 URL: ');
    
    if (url.toLowerCase() === 'quit' || url.toLowerCase() === 'q') {
      break;
    }

    if (!url.startsWith('http')) {
      console.log('   ❌ URL không hợp lệ. Phải bắt đầu bằng http:// hoặc https://\n');
      continue;
    }

    console.log('   ⏳ Đang tải...');

    try {
      const protocol = url.startsWith('https') ? https : http;
      
      await new Promise((resolve, reject) => {
        protocol.get(url, { 
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            console.log(`   ↪️  Redirect đến: ${res.headers.location}`);
            reject(new Error('Redirect - hãy dùng URL mới'));
            return;
          }

          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            
            // Try to get filename
            let filename = extractFilename(url, res.headers);
            if (!filename.endsWith('.pdf')) filename += '.pdf';

            const outputPath = path.join(OUTPUT_DIR, filename);
            fs.writeFileSync(outputPath, buffer);
            
            console.log(`   ✅ ĐÃ TẢI: ${filename} (${formatSize(buffer.length)})`);
            console.log(`   📁 Lưu tại: ${outputPath}\n`);
            resolve();
          });
          res.on('error', reject);
        }).on('error', reject);
      });
    } catch (err) {
      console.log(`   ❌ Lỗi: ${err.message}\n`);
    }
  }

  rl.close();
  console.log('\n👋 Tạm biệt!\n');
}

// Run
main().catch(err => {
  console.error('❌ Lỗi:', err.message);
  console.error(err);
  process.exit(1);
});
