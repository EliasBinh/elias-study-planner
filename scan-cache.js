/**
 * Classin PDF Downloader - Scan local cache for PDF files
 * Quét cache local của Classin desktop app để tìm file PDF đã được cache
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Known Classin cache/data directories on Windows
const POSSIBLE_PATHS = [
  path.join(os.homedir(), 'AppData', 'Local', 'ClassIn'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'ClassIn'),
  path.join(os.homedir(), 'AppData', 'Local', 'eeo'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'eeo'),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'ClassIn'),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'eeo'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ClassIn'),
  path.join(os.homedir(), 'Documents', 'ClassIn'),
  // Electron-based app paths
  path.join(os.homedir(), 'AppData', 'Local', 'classin-desktop'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'classin-desktop'),
];

const OUTPUT_DIR = path.join(__dirname, 'downloads');

function findPDFs(dir, results = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          findPDFs(fullPath, results);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
          const stats = fs.statSync(fullPath);
          results.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            modified: stats.mtime,
          });
        }
      } catch (err) {
        // Skip files we can't access
      }
    }
  } catch (err) {
    // Skip directories we can't access
  }
  return results;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main() {
  console.log('\n🔍 Classin PDF Cache Scanner');
  console.log('=' .repeat(50));
  console.log('Đang quét các thư mục cache của Classin...\n');

  let allPDFs = [];
  let foundDirs = [];

  for (const dir of POSSIBLE_PATHS) {
    if (fs.existsSync(dir)) {
      console.log(`📁 Tìm thấy thư mục: ${dir}`);
      foundDirs.push(dir);
      const pdfs = findPDFs(dir);
      allPDFs = allPDFs.concat(pdfs);
    }
  }

  // Also scan common install directories
  const programFiles = [
    'C:\\Program Files\\ClassIn',
    'C:\\Program Files (x86)\\ClassIn',
  ];
  for (const dir of programFiles) {
    if (fs.existsSync(dir)) {
      console.log(`📁 Tìm thấy thư mục cài đặt: ${dir}`);
      foundDirs.push(dir);
    }
  }

  if (foundDirs.length === 0) {
    console.log('⚠️  Không tìm thấy thư mục Classin nào.');
    console.log('   Classin có thể được cài đặt ở vị trí khác.');
    console.log('   Hãy thử chạy: download.js để dùng phương pháp browser.\n');
    
    // Try to find ClassIn by searching common directories
    console.log('🔎 Đang tìm kiếm ClassIn trên toàn bộ ổ C...');
    const searchDirs = [
      path.join(os.homedir(), 'AppData'),
      path.join(os.homedir(), 'Documents'),
    ];
    
    for (const searchDir of searchDirs) {
      if (fs.existsSync(searchDir)) {
        try {
          const entries = fs.readdirSync(searchDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && 
                (entry.name.toLowerCase().includes('classin') || 
                 entry.name.toLowerCase().includes('eeo'))) {
              const fullPath = path.join(searchDir, entry.name);
              console.log(`   📁 Phát hiện: ${fullPath}`);
              foundDirs.push(fullPath);
              const pdfs = findPDFs(fullPath);
              allPDFs = allPDFs.concat(pdfs);
            }
          }
        } catch (err) {}
      }
    }
  }

  console.log('\n' + '=' .repeat(50));
  
  if (allPDFs.length === 0) {
    console.log('📄 Không tìm thấy file PDF nào trong cache.');
    console.log('   → Hãy chạy: node download.js để dùng browser interceptor.\n');
    
    // List all directories found for debugging
    if (foundDirs.length > 0) {
      console.log('\nCác thư mục Classin tìm thấy:');
      for (const dir of foundDirs) {
        console.log(`  📁 ${dir}`);
        try {
          const items = fs.readdirSync(dir);
          for (const item of items.slice(0, 10)) {
            console.log(`     └─ ${item}`);
          }
          if (items.length > 10) {
            console.log(`     └─ ... và ${items.length - 10} mục khác`);
          }
        } catch (err) {}
      }
    }
    return;
  }

  // Sort by modification date, newest first
  allPDFs.sort((a, b) => b.modified - a.modified);

  console.log(`\n📄 Tìm thấy ${allPDFs.length} file PDF:\n`);
  
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let copied = 0;
  for (const pdf of allPDFs) {
    const outputPath = path.join(OUTPUT_DIR, pdf.name);
    console.log(`  📎 ${pdf.name}`);
    console.log(`     Kích thước: ${formatSize(pdf.size)}`);
    console.log(`     Ngày sửa: ${pdf.modified.toLocaleString('vi-VN')}`);
    console.log(`     Nguồn: ${pdf.path}`);
    
    if (!fs.existsSync(outputPath)) {
      try {
        fs.copyFileSync(pdf.path, outputPath);
        console.log(`     ✅ Đã copy đến: ${outputPath}`);
        copied++;
      } catch (err) {
        console.log(`     ❌ Lỗi copy: ${err.message}`);
      }
    } else {
      console.log(`     ⏭️  Đã tồn tại trong downloads/`);
    }
    console.log();
  }

  console.log('=' .repeat(50));
  console.log(`✅ Hoàn tất! Đã copy ${copied} file mới đến: ${OUTPUT_DIR}\n`);
}

main().catch(console.error);
