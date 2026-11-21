const http = require('http');

async function getTargets() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function cdpCall(wsUrl, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.close();
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    ws.onerror = (err) => reject(err);
    setTimeout(() => { ws.close(); reject(new Error('CDP Timeout')); }, 4000);
  });
}

(async () => {
  console.log('='.repeat(60));
  console.log('   🔍 THÔNG TIN KHÓA HỌC & BUỔI HỌC HIỆN TẠI TRÊN CLASSIN');
  console.log('='.repeat(60));

  const targets = await getTargets();
  const courseTarget = targets.find(t => t.url && t.url.includes('course/detail'));

  if (!courseTarget) {
    console.log('\n❌ Chưa phát hiện trang khóa học đang mở trong ClassIn.');
    console.log('👉 Vui lòng mở khóa học trên ClassIn rồi chạy lại script này!\n');
    return;
  }

  try {
    const evalRes = await cdpCall(courseTarget.webSocketDebuggerUrl, 1, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = Array.from(document.querySelectorAll('.activityRow__jdVhs, [class*="activityRow"]'));
        const list = [];
        for (const row of rows) {
          const fKey = Object.keys(row).find(k => k.startsWith('__reactFiber'));
          if (fKey && row[fKey]) {
            let curr = row[fKey];
            while (curr) {
              const mp = curr.memoizedProps;
              if (mp && mp.detail) {
                list.push({
                  name: mp.detail.name,
                  activityId: mp.detail.activityId,
                  bizId: mp.detail.bizId,
                  courseId: mp.courseId || 307666661,
                  schoolId: mp.schoolId || 69201116,
                  recordState: mp.detail.recordState,
                  time: mp.detail.startTime ? new Date(mp.detail.startTime * 1000).toLocaleString('vi-VN') : ''
                });
                break;
              }
              curr = curr.return;
            }
          }
        }
        return list;
      })()`,
      returnByValue: true
    });

    const lessons = evalRes.result ? evalRes.result.value : [];
    if (!lessons || lessons.length === 0) {
      console.log('\nℹ️ Đã kết nối ClassIn nhưng chưa thấy danh sách buổi học.');
    } else {
      console.log(`\n✅ Tìm thấy ${lessons.length} mục trong khóa học:\n`);
      lessons.forEach((l, idx) => {
        console.log(`[${idx + 1}] ${l.name}`);
        console.log(`    📅 Thời gian: ${l.time}`);
        console.log(`    🆔 Activity ID: ${l.activityId} | Lesson ID: ${l.bizId}`);
        console.log(`    🎥 Có video Record: ${l.recordState ? 'CÓ (Có sẵn bản ghi)' : 'Không'}`);
        console.log(`    🔗 Link nội bộ EEO: https://www.eeo.cn/live.php?lessonId=${l.bizId}`);
        console.log('-'.repeat(60));
      });
    }
  } catch (e) {
    console.error('Lỗi lấy thông tin:', e.message);
  }
})();

