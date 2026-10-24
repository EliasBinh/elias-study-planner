import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8899;
const CDP_PORT = 9222;

// Folders
const BASE_10SAT = path.join(os.homedir(), 'Downloads', '10SAT');
const VERBAL_DIR = path.join(BASE_10SAT, 'VERBAL');
const MATH_DIR = path.join(BASE_10SAT, 'MATH');
const DB_FILE = path.join(__dirname, 'database.json');

// Ensure directories exist
fs.mkdirSync(VERBAL_DIR, { recursive: true });
fs.mkdirSync(MATH_DIR, { recursive: true });

// Stores in memory
const pdfStore = new Map();
const todoStore = new Map();

let appSettings = {
  examDate: '2026-12-05T08:00',
  examTitle: 'Đếm ngược kỳ thi SAT',
  streak: {
    count: 1,
    lastDoneDate: '2026-10-17',
    lastDoneTime: '19:40',
    history: {}
  },
  skippedNoPdf: [],
  manualFileGroups: {},
  customTopicFolders: [],
  habits: {
    list: [
      { id: 'h_1', title: 'Dậy 4h00 sáng', category: 'Morning' },
      { id: 'h_2', title: 'Thiền 15 phút', category: 'Mindset' },
      { id: 'h_3', title: 'Tập Gym', category: 'Health' },
      { id: 'h_4', title: 'Học 4h SAT', category: 'Study' },
      { id: 'h_5', title: 'Học môn trên trường', category: 'School' },
      { id: 'h_6', title: 'Kỷ luật bản thân (Không fap/lọ)', category: 'Discipline' }
    ],
    history: {}
  },
  dailyPlanner: {
    tasks: [
      { id: 'dp_1', title: '1 câu trắc nghiệm toán cảnh', section: 'evening', completed: true, status: 'completed', date: '2026-10-22', deadline: '', spentSeconds: 0 }
    ],
    daysHistory: {},
    activeTimer: null
  },
  discordRpc: {
    enabled: true,
    clientId: '902536560539484202',
    activityType: 3, // 3: Watching, 5: Competing, 0: Playing
    mode: 'cumulative', // 'cumulative' | 'task'
    stateFormat: 'today_stats', // 'today_stats' | 'custom' | 'none'
    customState: '',
    restTitle: 'REST',
    largeImageStudy: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=512&auto=format&fit=crop&q=80',
    largeImageRest: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=512&auto=format&fit=crop&q=80',
    smallIconStudy: 'https://cdn-icons-png.flaticon.com/512/785/785116.png',
    smallIconRest: 'https://cdn-icons-png.flaticon.com/512/924/924514.png',
    smallTextStudy: 'Focusing',
    smallTextRest: 'Resting',
    largeText: 'SAT 1600 Focus',
    showTimer: true
  }
};

// Helper: Check if a task is a submission slot or live class (NOT a downloadable PDF test paper)
function isNonDownloadableTask(item) {
  if (!item) return false;
  if (item.courseId && item.courseId !== 312895237) return true;
  const t = (item.title || item.filename || '').toLowerCase().normalize('NFC');
  if (t.includes('vở ghi') || t.includes('nộp vở') || t.includes('chụp vở') || t.includes('vở') || t.includes('v\u1edf')) return true;
  if (t.startsWith('[10 edu 2026] sat') && !t.includes('lesson') && !t.includes('test')) return true;
  if (t.includes('mcombo') || t.includes('nội dung') || t.includes('n\u1ed9i dung')) return true;
  return false;
}

// Helper: Clean base filename
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

// Helper: Format standardized filename: [Done]? [DD.MM] [Subject] Clean_Name.pdf
function formatFilename(baseName, deadlineTag, subject, isDone = false) {
  const clean = cleanBaseName(baseName);
  const subj = subject.toLowerCase() === 'math' ? 'Math' : 'Verbal';
  const tag = (deadlineTag || '[17.10]').replace(/Hạn\s*/i, '').replace('-', '.');
  let result = `${tag} [${subj}] ${clean}`;
  if (isDone) result = `[Done] ${result}`;
  return result.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// Helper: Load database on startup
function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (data.settings) {
        appSettings = {
          ...appSettings,
          ...data.settings,
          streak: {
            ...appSettings.streak,
            ...(data.settings.streak || {}),
            history: { ...(data.settings.streak?.history || {}) }
          },
          skippedNoPdf: Array.isArray(data.settings.skippedNoPdf) ? data.settings.skippedNoPdf : [],
          manualFileGroups: (typeof data.settings.manualFileGroups === 'object' && data.settings.manualFileGroups !== null) ? data.settings.manualFileGroups : {},
          customTopicFolders: Array.isArray(data.settings.customTopicFolders) ? data.settings.customTopicFolders : [],
          habits: data.settings.habits || appSettings.habits,
          dailyPlanner: {
            tasks: Array.isArray(data.settings?.dailyPlanner?.tasks) ? data.settings.dailyPlanner.tasks : (appSettings.dailyPlanner?.tasks || []),
            daysHistory: (typeof data.settings?.dailyPlanner?.daysHistory === 'object' && data.settings.dailyPlanner.daysHistory !== null) ? data.settings.dailyPlanner.daysHistory : (appSettings.dailyPlanner?.daysHistory || {}),
            activeTimer: data.settings?.dailyPlanner?.activeTimer || null
          },
          discordRpc: {
            ...appSettings.discordRpc,
            ...(data.settings?.discordRpc || {})
          }
        };
      }
      // Populate history from existing completed items if empty
      if (!appSettings.streak.history || Object.keys(appSettings.streak.history).length === 0) {
        appSettings.streak.history = {};
        if (Array.isArray(data.items)) {
          for (const item of data.items) {
            if (item.isDone) {
              const dStr = (item.doneAt || '').split(' ')[0] || item.detectedAt || '2026-10-17';
              const validDate = /^\d{4}-\d{2}-\d{2}$/.test(dStr) ? dStr : '2026-10-17';
              appSettings.streak.history[validDate] = (appSettings.streak.history[validDate] || 0) + 1;
            }
          }
        }
      }
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          pdfStore.set(item.id || item.url, item);
        }
      }
      if (Array.isArray(data.todos)) {
        for (const todo of data.todos) {
          if (isNonDownloadableTask(todo)) continue;
          todoStore.set(todo.id, todo);
        }
      }
    }
  } catch (err) {
    console.error('[DB] Lỗi nạp database:', err.message);
  }
}

// Helper: Save database
function saveDatabase() {
  try {
    const data = {
      updatedAt: new Date().toISOString(),
      settings: appSettings,
      items: Array.from(pdfStore.values()),
      todos: Array.from(todoStore.values())
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Lỗi lưu database:', err.message);
  }
}

// Subject detection logic
function detectSubject(title = '', altText = '') {
  const t = (title + ' ' + altText).toLowerCase();

  const mathKeywords = [
    'math', 'algebra', 'geometry', 'statistic', 'toán', 'function', 'equation', 
    'triangle', 'circle', 'polynomial', 'graph', 'm-ad', 'sat m-', 'calculus', 
    'probability', 'arithmetic', 'coordinate', 'parabola', 'linear',
    'area', 'volume', 'ratio', 'percentage', 'percent', 'angle', 'line', 'rates',
    'quadratic', 'integer', 'exponent', 'quadrilateral', 'polygon', 'inequality', 'system'
  ];
  const verbalKeywords = [
    'verbal', 'ebrw', 'words in context', 'critical reader', 'literary art', 'central idea', 
    'reading', 'writing', 'v-ad', 'sat v-', 'vocabulary', 'passage', 'remains of the day', 
    'conventions', 'standard english', 'craft', 'structure', 'rhetorical', 'textual',
    'dune', 'society', 'markets', 'synthesis'
  ];

  let mathScore = 0;
  let verbalScore = 0;

  for (const kw of mathKeywords) {
    if (t.includes(kw)) mathScore += 2;
  }
  for (const kw of verbalKeywords) {
    if (t.includes(kw)) verbalScore += 2;
  }

  if (mathScore > verbalScore) return 'MATH';
  if (verbalScore > mathScore) return 'VERBAL';
  if (/lesson\s*\d+/i.test(t) && verbalScore === 0) return 'MATH';
  return 'VERBAL';
}

// Helper: Extract key terms from title/filename for matching
function extractKey(str = '') {
  return str.toLowerCase()
    .replace(/^\[done\]\s*/i, '')
    .replace(/^\[\d{1,2}[.-]\d{1,2}\]\s*/i, '')
    .replace(/^\[hạn\s*\d{1,2}[.-]\d{1,2}\]\s*/i, '')
    .replace(/^chưa rõ\s*/i, '')
    .replace(/^\[(math|verbal)\]\s*/i, '')
    .replace(/final/gi, ' ')
    .replace(/test\s*paper/gi, ' ')
    .replace(/aanhlle_['’s\s]*collections/gi, ' ')
    .replace(/([a-z]+)(\d+)/gi, '$1 $2')
    .replace(/(\d+)([a-z]+)/gi, '$1 $2')
    .replace(/\.pd(\.pdf)?$/i, '')
    .replace(/\.pdf$/i, '')
    .trim();
}

function normalizeTitle(t = '') {
  return extractKey(t)
    .replace(/[\[\]\(\)\|\:\_\-\.\,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract specific numbers (e.g. Lesson number, set number, No. number)
function extractSetNumbers(str = '') {
  const norm = normalizeTitle(str);
  const res = {};
  
  const lessonMatch = norm.match(/lesson\s*(\d+)/);
  if (lessonMatch) res.lesson = lessonMatch[1];
  
  const noMatch = norm.match(/no\s*(\d+)/);
  if (noMatch) res.no = noMatch[1];

  const setMatch = norm.match(/set\s*(\d+|[a-z])\b/);
  if (setMatch) res.set = setMatch[1];

  const wordsInContextMatch = norm.match(/words\s*in\s*context\s*(\d+)/);
  if (wordsInContextMatch) res.wic = wordsInContextMatch[1];

  return res;
}

// Helper: Match PDF title with known To-do items
function matchTodo(title = '', filename = '', excludeIds = null) {
  const combined = (title + ' ' + filename).toLowerCase();
  const fileNumbers = extractSetNumbers(combined);
  const normSearch = normalizeTitle(title || filename);
  
  let bestTodo = null;
  let highestScore = -1;

  for (const todo of todoStore.values()) {
    if (excludeIds && excludeIds.has(todo.id)) continue;
    const todoCombined = todo.title.toLowerCase();
    const todoNumbers = extractSetNumbers(todoCombined);
    
    // Strict number constraints:
    if (fileNumbers.lesson && todoNumbers.lesson && fileNumbers.lesson !== todoNumbers.lesson) continue;
    if (fileNumbers.no && todoNumbers.no && fileNumbers.no !== todoNumbers.no) continue;
    if (fileNumbers.set && todoNumbers.set && fileNumbers.set !== todoNumbers.set) continue;
    if (fileNumbers.wic && todoNumbers.wic && fileNumbers.wic !== todoNumbers.wic) continue;

    // Check exact title equivalence
    const normTodo = normalizeTitle(todo.title);
    if (normSearch === normTodo) {
      let score = 200;
      if (todo.endTime > 0) score += 20; // prefer active deadline
      if (score > highestScore) {
        highestScore = score;
        bestTodo = todo;
      }
      continue;
    }

    // Keyword scoring
    const searchWords = normSearch.split(' ').filter(w => w.length > 1);
    const todoWords = normTodo.split(' ').filter(w => w.length > 1);
    let matchedWords = 0;
    let hasUniqueMatch = false;

    for (const w of todoWords) {
      const match = searchWords.find(sw => sw === w || (sw.length > 3 && (sw.startsWith(w) || w.startsWith(sw))));
      if (match) {
        matchedWords++;
        if (['dune', 'literary', 'remains', 'quadratic', 'probability', 'statistics', 'circles'].includes(w)) {
          hasUniqueMatch = true;
        }
      }
    }

    const similarity = matchedWords / Math.max(todoWords.length, 1);
    if (similarity >= 0.33 || hasUniqueMatch) {
      let score = matchedWords * 10;
      if (hasUniqueMatch) score += 30;
      if (fileNumbers.no && todoNumbers.no && fileNumbers.no === todoNumbers.no) score += 20;
      if (fileNumbers.lesson && todoNumbers.lesson && fileNumbers.lesson === todoNumbers.lesson) score += 20;
      if (fileNumbers.set && todoNumbers.set && fileNumbers.set === todoNumbers.set) score += 20;
      if (todo.endTime > 0) score += 5;
      if (score > highestScore) {
        highestScore = score;
        bestTodo = todo;
      }
    }
  }

  return bestTodo;
}

// Format deadline string to [DD.MM]
function getDeadlineTag(todo) {
  if (!todo || !todo.endTime) return '';
  const d = new Date(todo.endTime * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `[${day}.${month}]`;
}

// Re-match all items with current todos
function matchAllTodos() {
  let changed = false;
  const claimed = new Set();
  for (const item of pdfStore.values()) {
    const todo = matchTodo(item.title, item.filename, claimed);
    if (todo) {
      claimed.add(todo.id);
      const tag = getDeadlineTag(todo);
      if (tag && item.deadlineTag !== tag) {
        item.deadlineTag = tag;
        item.deadlineDate = todo.deadlineDate || '';
        changed = true;
      }
      if (!item.title || item.title.includes('Chưa rõ') || item.title.includes('final') || item.title.includes('[')) {
        item.title = todo.title;
        changed = true;
      }
    }
  }
  if (changed) saveDatabase();
}

// Sync files already on disk in VERBAL and MATH folders
// Sync files already on disk in VERBAL and MATH folders
function indexLocalFolders() {
  // Clean up any items whose files were moved or deleted from disk
  for (const [key, item] of pdfStore.entries()) {
    if (item.localPath && !fs.existsSync(item.localPath)) {
      pdfStore.delete(key);
    }
  }

  const folders = [
    { dir: VERBAL_DIR, subject: 'VERBAL' },
    { dir: MATH_DIR, subject: 'MATH' }
  ];

  for (const { dir, subject } of folders) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.pdf')) continue;
      const fullPath = path.join(dir, file);
      const isDone = file.startsWith('[Done]');
      const cleanTitle = cleanBaseName(file).replace(/\.pdf$/i, '');
      let exists = Array.from(pdfStore.values()).find(item => 
        item.localPath === fullPath || 
        item.filename === file ||
        (item.filename && cleanBaseName(item.filename) === cleanBaseName(file)) ||
        (item.title && cleanBaseName(item.title).toLowerCase() === cleanBaseName(cleanTitle).toLowerCase())
      );
      if (!exists) {
        const id = 'local_' + crypto.createHash('md5').update(fullPath).digest('hex').slice(0, 12);
        const detectedSubject = detectSubject(file);
        const todo = matchTodo(cleanTitle, file);
        const deadlineTag = getDeadlineTag(todo) || (subject === 'MATH' ? '[21.10]' : '[17.10]');

        pdfStore.set(id, {
          id,
          filename: file,
          title: todo ? todo.title : cleanTitle,
          url: '',
          subject: subject || detectedSubject,
          recommendedSubject: detectedSubject,
          deadlineTag: deadlineTag,
          deadlineDate: todo?.deadlineDate || '',
          customDeadline: null,
          isDone,
          downloaded: true,
          localPath: fullPath,
          detectedAt: new Date().toLocaleTimeString('vi-VN')
        });
      } else {
        exists.downloaded = true;
        exists.localPath = fullPath;
        exists.isDone = isDone;
        exists.subject = subject;
        exists.filename = file;
        const todo = matchTodo(exists.title || cleanTitle, file);
        if (todo) {
          exists.title = todo.title;
          const tag = getDeadlineTag(todo);
          if (tag) exists.deadlineTag = tag;
          if (todo.deadlineDate) exists.deadlineDate = todo.deadlineDate;
        } else if (!exists.title || exists.title.startsWith('Chưa rõ')) {
          exists.title = cleanTitle;
        }
      }
    }
  }
  saveDatabase();
}

// Helper: send CDP command over WebSocket
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1000000);
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      resolve(null);
    }, 4000);

    const onMsg = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener('message', onMsg);
          resolve(msg.result);
        }
      } catch (e) {}
    };

    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Background scan worker
async function scanClassIn() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) });
    const targets = await res.json();

    for (const target of targets) {
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;

      let ws;
      try {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
          setTimeout(() => reject(new Error('WS timeout')), 2500);
        });

        // 1. If this is To-do page, extract all to-do items from React Fibers
        if (target.url.includes('todo') || target.title.includes('ClassIn')) {
          const todoRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(() => {
              const allCards = [];
              const seen = new Set();
              const elements = document.querySelectorAll('.hoverItem__ARHDY, .baseTodoItem__D5dSs');
              elements.forEach(el => {
                const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                if (!reactKey) return;
                let cur = el[reactKey];
                let item = null;
                while (cur && !item) {
                  if (cur.memoizedProps?.item?.title) {
                    item = cur.memoizedProps.item;
                  }
                  cur = cur.return;
                }
                if (item && !seen.has(item.id)) {
                  seen.add(item.id);
                  const deadlineDate = item.end_time ? new Date(item.end_time * 1000) : null;
                  let deadlineStr = '';
                  if (deadlineDate) {
                    const day = String(deadlineDate.getDate()).padStart(2, '0');
                    const month = String(deadlineDate.getMonth() + 1).padStart(2, '0');
                    deadlineStr = \`[\${day}.\${month}]\`;
                  }
                  allCards.push({
                    id: item.id,
                    title: item.title,
                    courseId: item.content?.courseId || item.group_id,
                    activityId: item.content?.activityId,
                    timeLimit: item.content?.timeLimit || 0,
                    endTime: item.end_time,
                    deadlineDate: deadlineDate ? deadlineDate.toLocaleString('vi-VN') : '',
                    deadlineTag: deadlineStr,
                    isCompleted: item.is_cmplt === 1 || item.cmplt_time > 0
                  });
                }
              });
              return allCards;
            })()`,
            returnByValue: true
          });

          const extractedTodos = todoRes?.result?.value;
          if (Array.isArray(extractedTodos) && extractedTodos.length > 0) {
            for (const t of extractedTodos) {
              if (isNonDownloadableTask(t)) continue;
              todoStore.set(t.id, t);
            }
            matchAllTodos();
            saveDatabase();
          }
        }

        // 2. Extract PDF network resources from performance API
        const perfRes = await cdpSend(ws, 'Runtime.evaluate', {
          expression: `(() => {
            const res = performance.getEntriesByType('resource').map(r => r.name);
            return res.filter(url => {
              const u = url.toLowerCase();
              return u.includes('.pdf') && !u.includes('.png') && !u.includes('.jpg') && !u.includes('.jpeg') && !u.includes('.gif');
            });
          })()`,
          returnByValue: true
        });

        // 3. Extract DOM text names
        const domRes = await cdpSend(ws, 'Runtime.evaluate', {
          expression: `(() => {
            const names = [];
            const walk = (node) => {
              if (node.nodeType === 3) {
                const t = node.nodeValue.trim();
                if (t.endsWith('.pdf') || (t.includes('HW') && t.includes('('))) {
                  names.push(t);
                }
              }
              for (let child of node.childNodes) walk(child);
            };
            walk(document.body);
            return Array.from(new Set(names));
          })()`,
          returnByValue: true
        });

        ws.close();

        const pdfUrls = perfRes?.result?.value || [];
        const domNames = domRes?.result?.value || [];
        const defaultName = domNames.find(n => n.endsWith('.pdf')) || domNames[0] || 'ClassIn_Homework.pdf';

        for (const pdfUrl of pdfUrls) {
          let cleanName = defaultName;
          if (!cleanName.toLowerCase().endsWith('.pdf')) cleanName += '.pdf';
          cleanName = cleanName.replace(/[<>:"/\\|?*]/g, '_').trim();

          const uniqueId = crypto.createHash('md5').update(pdfUrl).digest('hex');
          const detectedSubject = detectSubject(cleanName, target.title);
          const todo = matchTodo(cleanName, target.title);
          const deadlineTag = getDeadlineTag(todo) || (detectedSubject === 'MATH' ? '[21.10]' : '[17.10]');

          let existingItem = pdfStore.get(pdfUrl) || Array.from(pdfStore.values()).find(i => 
            i.id === uniqueId || 
            i.url === pdfUrl ||
            (i.filename && cleanBaseName(i.filename) === cleanBaseName(cleanName)) ||
            (todo && (i.todoId === todo.id || i.title === todo.title))
          );

          const subj = existingItem?.subject || detectedSubject;
          const destDir = subj === 'MATH' ? MATH_DIR : VERBAL_DIR;
          const formattedName = formatFilename(cleanName, deadlineTag, subj);
          const destPath = path.join(destDir, formattedName);

          let hasLocal = existingItem?.localPath && fs.existsSync(existingItem.localPath);
          let finalPath = hasLocal ? existingItem.localPath : destPath;
          let downloaded = hasLocal;

          if (!hasLocal) {
            try {
              await fetchFile(pdfUrl, destPath);
              downloaded = true;
              finalPath = destPath;
            } catch (dlErr) {
            }
          }

          if (!existingItem) {
            pdfStore.set(pdfUrl, {
              id: uniqueId,
              filename: formattedName,
              title: todo ? todo.title : (domNames.length > 1 ? domNames[1] : cleanName),
              url: pdfUrl,
              pageUrl: target.url,
              subject: subj,
              recommendedSubject: detectedSubject,
              deadlineTag: deadlineTag,
              deadlineDate: todo?.deadlineDate || '',
              customDeadline: null,
              detectedAt: new Date().toLocaleTimeString('vi-VN'),
              downloaded: downloaded,
              isDone: false,
              localPath: downloaded ? finalPath : null
            });
            saveDatabase();
            console.log(`[+]  ${cleanBaseName(cleanName)} [${subj}] ${deadlineTag}`);
          } else {
            if (!existingItem.url) existingItem.url = pdfUrl;
            if (downloaded && (!existingItem.localPath || !fs.existsSync(existingItem.localPath))) {
              existingItem.localPath = finalPath;
              existingItem.downloaded = true;
              existingItem.filename = formattedName;
              saveDatabase();
              console.log(`[+]  ${cleanBaseName(cleanName)} [${subj}] ${deadlineTag}`);
            }
          }
        }
      } catch (err) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      }
    }
  } catch (err) {
    // Port 9222 might not be open
  }
}

// Poll every 3 seconds
setInterval(scanClassIn, 3000);

// Helper: Download file from URL
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
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(destPath);
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Helper: Automatically download any items that have a URL but no file on disk
async function autoDownloadMissingFiles() {
  for (const item of pdfStore.values()) {
    if (item.url && (!item.localPath || !fs.existsSync(item.localPath))) {
      const subj = item.subject || detectSubject(item.filename || item.title);
      const destDir = subj === 'MATH' ? MATH_DIR : VERBAL_DIR;
      const formattedName = formatFilename(item.filename || item.title, item.deadlineTag, subj);
      const destPath = path.join(destDir, formattedName);
      try {
        await fetchFile(item.url, destPath);
        item.localPath = destPath;
        item.downloaded = true;
        item.filename = formattedName;
        saveDatabase();
        console.log(`[+]  ${cleanBaseName(formattedName)} [${subj}] ${item.deadlineTag || ''}`);
      } catch (err) {
      }
    }
  }
}

// Helper: Check if a task is a timed exam (100% strict safe classification)
function isTimedExam(item) {
  if (!item) return false;
  if ((item.timeLimit || 0) > 0) return true;
  if (item.isTest) return true;
  const t = (item.title || item.filename || '').toLowerCase();
  if (t.includes('hw:') || t.includes('hw.')) return true;
  if (t.includes('algebra') && t.includes('lesson')) return true;
  if (t.includes('geometry') && t.includes('lesson')) return true;
  if (/\b(bài thi|kiểm tra|\d+\s*phút)\b/i.test(t)) return true;
  return false;
}

// Helper: Merge Todos and PDFs into unified item list
function getMergedItems() {
  const merged = [];
  const matchedTodoIds = new Set();
  const matchedPdfIds = new Set();

  // Pre-index todos by normalized title to de-duplicate across courses
  const todosByNormTitle = new Map();
  for (const todo of todoStore.values()) {
    if (isNonDownloadableTask(todo)) continue;
    const k = normalizeTitle(todo.title);
    if (!todosByNormTitle.has(k)) todosByNormTitle.set(k, []);
    todosByNormTitle.get(k).push(todo);
  }

  // 1. Map PDFs that match with a known Todo
  const claimedTodoIds = new Set();
  for (const pdf of pdfStore.values()) {
    const todo = matchTodo(pdf.title, pdf.filename, claimedTodoIds);
    if (todo) {
      claimedTodoIds.add(todo.id);
      matchedPdfIds.add(pdf.id);
      const normK = normalizeTitle(todo.title);
      const relatedTodos = todosByNormTitle.get(normK) || [todo];
      for (const t of relatedTodos) {
        matchedTodoIds.add(t.id);
        claimedTodoIds.add(t.id);
      }

      // Prioritize the todo that has an active deadline
      const bestTodo = relatedTodos.find(t => t.endTime > 0) || todo;
      const timed = isTimedExam(bestTodo);
      merged.push({
        ...pdf,
        title: bestTodo.title,
        todoId: bestTodo.id,
        activityId: bestTodo.activityId,
        courseId: bestTodo.courseId,
        timeLimit: bestTodo.timeLimit || (timed ? 80 : 0),
        endTime: bestTodo.endTime,
        hasFile: true,
        downloaded: !!pdf.localPath && fs.existsSync(pdf.localPath),
        isTest: timed,
        isTimed: timed,
        deadlineTag: bestTodo.deadlineTag || pdf.deadlineTag || 'Chưa rõ hạn',
        deadlineDate: bestTodo.deadlineDate || pdf.deadlineDate || '',
        subject: pdf.subject || detectSubject(bestTodo.title)
      });
    }
  }

  // 2. Add PDFs that did not match any Todo
  for (const pdf of pdfStore.values()) {
    if (!matchedPdfIds.has(pdf.id)) {
      const timed = isTimedExam(pdf);
      merged.push({
        ...pdf,
        hasFile: true,
        downloaded: !!pdf.localPath && fs.existsSync(pdf.localPath),
        isTest: timed,
        isTimed: timed,
        deadlineTag: pdf.deadlineTag || 'Chưa rõ hạn'
      });
    }
  }

  // 3. Add Todos that do not have a matching PDF yet (de-duplicate across courses)
  const seenPendingTitles = new Set();
  for (const todo of todoStore.values()) {
    if (isNonDownloadableTask(todo)) continue;
    if (matchedTodoIds.has(todo.id)) continue;

    const normK = normalizeTitle(todo.title);
    if (seenPendingTitles.has(normK)) continue;
    seenPendingTitles.add(normK);

    const relatedTodos = todosByNormTitle.get(normK) || [todo];
    const bestPendingTodo = relatedTodos.find(t => t.endTime > 0) || todo;
    for (const t of relatedTodos) matchedTodoIds.add(t.id);

    const detectedSubj = detectSubject(bestPendingTodo.title);
    const timed = isTimedExam(bestPendingTodo);
    const isSkippedNoPdf = (appSettings.skippedNoPdf || []).some(k => 
      k === bestPendingTodo.id || 
      k === ('todo_' + bestPendingTodo.id) || 
      k === normalizeTitle(bestPendingTodo.title)
    );

    merged.push({
      id: 'todo_' + bestPendingTodo.id,
      todoId: bestPendingTodo.id,
      activityId: bestPendingTodo.activityId,
      courseId: bestPendingTodo.courseId,
      timeLimit: bestPendingTodo.timeLimit || (timed ? 80 : 0),
      endTime: bestPendingTodo.endTime,
      title: bestPendingTodo.title,
      filename: bestPendingTodo.title + '.pdf',
      url: '',
      subject: bestPendingTodo.subject || detectedSubj,
      recommendedSubject: detectedSubj,
      deadlineTag: bestPendingTodo.deadlineTag || 'Chưa rõ hạn',
      deadlineDate: bestPendingTodo.deadlineDate || '',
      customDeadline: bestPendingTodo.customDeadline || null,
      isDone: !!bestPendingTodo.isCompleted,
      downloaded: false,
      hasFile: false,
      noPdf: isSkippedNoPdf,
      localPath: null,
      isTest: timed,
      isTimed: timed,
      detectedAt: bestPendingTodo.detectedAt || ''
    });
  }

  return merged;
}

// ========================================================
// DISCORD RICH PRESENCE (RPC) VIA LOCAL IPC PIPE
// ========================================================
let discordIpcClient = null;
let discordIpcConnected = false;
let discordUserInfo = null;
let discordReconnectTimer = null;
let discordTestClearTimer = null;
let discordRestStartedAt = Date.now();

function getTodayStudySeconds() {
  const today = new Date().toISOString().slice(0, 10);
  const dayStats = appSettings.dailyPlanner?.daysHistory?.[today];
  let total = dayStats?.totalSeconds || 0;
  const active = appSettings.dailyPlanner?.activeTimer;
  if (active && active.startedAt) {
    total += Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
  }
  return total;
}

function formatTaskElapsed(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) {
    const remM = Math.floor((sec % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(remM).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTotalStudy(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${Math.max(0, m)}m`;
}

function encodeDiscordPayload(op, data) {
  const payload = Buffer.from(JSON.stringify(data));
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(payload.length, 4);
  payload.copy(buf, 8);
  return buf;
}

function initDiscordIpc() {
  if (!appSettings.discordRpc?.enabled) {
    disconnectDiscordIpc();
    return;
  }

  if (discordIpcClient) return;

  const pipePath = '\\\\.\\pipe\\discord-ipc-0';
  let client;
  try {
    client = net.createConnection(pipePath);
  } catch (err) {
    scheduleDiscordReconnect();
    return;
  }

  client.on('connect', () => {
    const clientId = appSettings.discordRpc?.clientId || '902536560539484202';
    try {
      client.write(encodeDiscordPayload(0, { v: 1, client_id: clientId }));
    } catch (e) {}
  });

  client.on('data', (data) => {
    try {
      let offset = 0;
      while (offset + 8 <= data.length) {
        const op = data.readInt32LE(offset);
        const len = data.readInt32LE(offset + 4);
        if (offset + 8 + len > data.length) break;
        const payloadBuf = data.slice(offset + 8, offset + 8 + len);
        offset += 8 + len;

        const payload = JSON.parse(payloadBuf.toString());
        if (payload.evt === 'READY') {
          discordIpcConnected = true;
          discordIpcClient = client;
          discordUserInfo = payload.data?.user || null;
          console.log(`[Discord RPC] Connected successfully as @${discordUserInfo?.username || 'User'}`);
          syncDiscordPresenceFromActiveTimer(true);
        }
      }
    } catch (e) {}
  });

  client.on('error', (err) => {
    disconnectDiscordIpc();
    scheduleDiscordReconnect();
  });

  client.on('close', () => {
    disconnectDiscordIpc();
    scheduleDiscordReconnect();
  });
}

function scheduleDiscordReconnect() {
  if (appSettings.discordRpc?.enabled && !discordReconnectTimer) {
    discordReconnectTimer = setTimeout(() => {
      discordReconnectTimer = null;
      initDiscordIpc();
    }, 15000);
  }
}

function disconnectDiscordIpc() {
  if (discordIpcClient) {
    try { discordIpcClient.destroy(); } catch (e) {}
    discordIpcClient = null;
  }
  discordIpcConnected = false;
  discordUserInfo = null;
}

let lastDiscordActivitySent = 0;
let pendingDiscordActivity = null;
let pendingDiscordTimer = null;
const DISCORD_ACTION_MIN_GAP = 1200; // 1.2s safety gap between rapid clicks to prevent Discord IPC pipe drops

function updateDiscordActivity(activity, immediate = false) {
  if (!discordIpcClient || !discordIpcConnected) return;

  if (immediate) {
    if (pendingDiscordTimer) {
      clearTimeout(pendingDiscordTimer);
      pendingDiscordTimer = null;
    }
    pendingDiscordActivity = null;
  }

  // 1-second live tick to Discord
  sendDiscordActivityNow(activity);
}

function sendDiscordActivityNow(activity) {
  if (!discordIpcClient || !discordIpcConnected) return;
  try {
    lastDiscordActivitySent = Date.now();
    const msg = {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: activity
      },
      nonce: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    };
    discordIpcClient.write(encodeDiscordPayload(1, msg));
  } catch (err) {
    console.error('[Discord RPC] Write error:', err);
  }
}

function syncDiscordPresenceFromActiveTimer(immediate = false) {
  if (!appSettings.discordRpc?.enabled) {
    updateDiscordActivity(null, immediate);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayTotalSec = getTodayStudySeconds();
  const activityType = Number(appSettings.discordRpc?.activityType !== undefined ? appSettings.discordRpc.activityType : 3); // 3: Watching, 0: Playing, 5: Competing
  const active = appSettings.dailyPlanner?.activeTimer;

  // Aesthetic High-Res Images & Icons (No emoji)
  const largeImgStudy = appSettings.discordRpc?.largeImageStudy || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=512&auto=format&fit=crop&q=80';
  const largeImgRest = appSettings.discordRpc?.largeImageRest || 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=512&auto=format&fit=crop&q=80';
  const smallIconStudy = appSettings.discordRpc?.smallIconStudy || 'https://cdn-icons-png.flaticon.com/512/785/785116.png';
  const smallIconRest = appSettings.discordRpc?.smallIconRest || 'https://cdn-icons-png.flaticon.com/512/924/924514.png';
  const smallTextStudy = appSettings.discordRpc?.smallTextStudy || 'Focusing';
  const smallTextRest = appSettings.discordRpc?.smallTextRest || 'Resting';
  const largeText = (appSettings.discordRpc?.largeText && appSettings.discordRpc.largeText.trim()) ? appSettings.discordRpc.largeText.trim() : undefined;

  if (active) {
    // 1. FOCUS / STUDY MODE
    discordRestStartedAt = null;
    const taskTitle = (appSettings.discordRpc?.studyTitle && appSettings.discordRpc.studyTitle.trim())
      ? appSettings.discordRpc.studyTitle.trim()
      : (active.taskTitle || 'FOCUS');
    const taskObj = (appSettings.dailyPlanner?.tasks || []).find(t => t.id === active.taskId);
    const taskElapsedSec = (taskObj?.spentSeconds || 0) + Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));

    // State line:
    let stateText = undefined;
    const stateFmt = appSettings.discordRpc?.stateFormat || 'today_stats';
    if (stateFmt === 'today_stats') {
      if (appSettings.discordRpc?.mode === 'task') {
        stateText = `Total today: ${formatTotalStudy(todayTotalSec)}`;
      } else {
        stateText = `Task: ${formatTotalStudy(taskElapsedSec)}`;
      }
    } else if (stateFmt === 'custom') {
      stateText = appSettings.discordRpc?.customState || undefined;
    }

    // Timestamp calculation with stable anchor:
    let startSec;
    if (appSettings.discordRpc?.mode === 'task') {
      const taskBaseStartedAt = active.startedAt - (taskObj?.spentSeconds || 0) * 1000;
      startSec = Math.floor(taskBaseStartedAt / 1000);
    } else {
      const dayStats = appSettings.dailyPlanner?.daysHistory?.[today];
      const cumBaseStartedAt = active.startedAt - (dayStats?.totalSeconds || 0) * 1000;
      startSec = Math.floor(cumBaseStartedAt / 1000);
    }

    updateDiscordActivity({
      type: activityType,
      details: taskTitle,
      state: stateText,
      timestamps: appSettings.discordRpc?.showTimer !== false ? { start: startSec } : undefined,
      assets: {
        large_image: largeImgStudy,
        large_text: largeText,
        small_image: smallIconStudy,
        small_text: smallTextStudy
      },
      instance: true
    }, immediate);
  } else {
    // 2. REST / BREAK MODE (User paused/stopped task: RPC remains active with REST status & timer!)
    if (!discordRestStartedAt) {
      discordRestStartedAt = Date.now();
    }
    const restTitle = appSettings.discordRpc?.restTitle || 'REST';
    const restStartSec = Math.floor(discordRestStartedAt / 1000);

    let stateText = undefined;
    const stateFmt = appSettings.discordRpc?.stateFormat || 'today_stats';
    if (stateFmt !== 'none') {
      stateText = `Total today: ${formatTotalStudy(todayTotalSec)}`;
    }

    updateDiscordActivity({
      type: activityType,
      details: restTitle,
      state: stateText,
      timestamps: appSettings.discordRpc?.showTimer !== false ? { start: restStartSec } : undefined,
      assets: {
        large_image: largeImgRest,
        large_text: largeText,
        small_image: smallIconRest,
        small_text: smallTextRest
      },
      instance: true
    }, immediate);
  }
}

// Background periodic sync: Refresh Discord presence every 15s to keep minutes fresh without tripping Discord's 5 reqs/20s rate limit
setInterval(() => {
  if (discordIpcConnected && appSettings.discordRpc?.enabled && appSettings.dailyPlanner?.activeTimer) {
    syncDiscordPresenceFromActiveTimer(false);
  }
}, 15000);

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // 1. API: List detected PDFs & stats & settings
  if (parsedUrl.pathname === '/api/list') {
    let connected = false;
    try {
      const check = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) });
      connected = check.ok;
    } catch {}

    const items = getMergedItems();
    const mathFilesOnDisk = fs.existsSync(MATH_DIR) ? fs.readdirSync(MATH_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).length : 0;
    const verbalFilesOnDisk = fs.existsSync(VERBAL_DIR) ? fs.readdirSync(VERBAL_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).length : 0;

    const stats = {
      total: items.length,
      hasFile: items.filter(i => i.hasFile).length,
      pendingFile: items.filter(i => !i.hasFile).length,
      done: items.filter(i => i.isDone).length,
      pending: items.filter(i => !i.isDone).length,
      math: mathFilesOnDisk,
      verbal: verbalFilesOnDisk,
      mathFiles: mathFilesOnDisk,
      verbalFiles: verbalFilesOnDisk,
      mathTotal: items.filter(i => i.subject === 'MATH').length,
      verbalTotal: items.filter(i => i.subject === 'VERBAL').length,
      timedExams: items.filter(i => i.isTimed).length,
      safeHomeworks: items.filter(i => !i.isTimed).length,
      pendingSafeHomeworks: items.filter(i => !i.hasFile && !i.isTimed && !i.noPdf).length
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      connected,
      baseDir: BASE_10SAT,
      verbalDir: VERBAL_DIR,
      mathDir: MATH_DIR,
      stats,
      settings: appSettings,
      items
    }));
  }

  // 2. API: Trigger scan
  if (parsedUrl.pathname === '/api/scan') {
    await scanClassIn();
    indexLocalFolders();
    matchAllTodos();
    await autoDownloadMissingFiles();
    indexLocalFolders();
    const items = getMergedItems();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, count: items.length }));
  }

  // 2b. API: Connect / Launch ClassIn with debugging port 9222
  if (parsedUrl.pathname === '/api/connect-classin' && req.method === 'POST') {
    try {
      let connected = false;
      try {
        const check = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) });
        connected = check.ok;
      } catch {}

      if (connected) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, connected: true, message: 'ClassIn đã kết nối sẵn sàng!' }));
      }

      const classInPath = 'C:\\Program Files (x86)\\ClassIn\\ClassIn.exe';
      if (fs.existsSync(classInPath)) {
        exec('taskkill /f /im ClassIn.exe & taskkill /f /im "ClassIn Helper.exe"', () => {
          setTimeout(() => {
            exec(`start "" "${classInPath}" --remote-debugging-port=9222`);
          }, 600);
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, connected: false, message: 'Đang khởi động ClassIn với cổng 9222...' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, message: 'Không tìm thấy ClassIn tại ' + classInPath }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: false, message: err.message }));
    }
  }

  // 3. API: List To-do items
  if (parsedUrl.pathname === '/api/todos') {
    const todos = Array.from(todoStore.values());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ count: todos.length, todos }));
  }

  // 4. API: Stream PDF for in-app Preview
  if (parsedUrl.pathname === '/api/preview') {
    const id = parsedUrl.searchParams.get('id');
    const item = Array.from(pdfStore.values()).find(p => p.id === id);

    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Không tìm thấy file để xem trước.');
    }

    if (item.localPath && fs.existsSync(item.localPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(item.filename)}"`,
        'Content-Length': fs.statSync(item.localPath).size
      });
      return fs.createReadStream(item.localPath).pipe(res);
    }

    if (item.url) {
      const client = item.url.startsWith('https') ? https : http;
      const proxyReq = client.get(item.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://b1s-cdn.eeo.cn/'
        }
      }, (proxyRes) => {
        if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
          res.writeHead(302, { 'Location': `/api/preview?url=${encodeURIComponent(proxyRes.headers.location)}` });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${encodeURIComponent(item.filename)}"`
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Lỗi tải preview: ${err.message}`);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('URL không hợp lệ.');
  }

  // 5. API: Set subject (Math / Verbal) & immediately move/rename file on disk
  if (parsedUrl.pathname === '/api/set-subject') {
    const id = parsedUrl.searchParams.get('id');
    const targetSubject = (parsedUrl.searchParams.get('subject') || 'Verbal').trim();
    const isMath = targetSubject.toLowerCase() === 'math';
    const subjUpper = isMath ? 'MATH' : 'VERBAL';
    const subjTitle = isMath ? 'Math' : 'Verbal';
    const targetDir = isMath ? MATH_DIR : VERBAL_DIR;

    if (id && id.startsWith('todo_')) {
      const todoId = Number(id.replace('todo_', ''));
      const todo = todoStore.get(todoId);
      if (todo) {
        todo.subject = subjUpper;
        saveDatabase();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, subject: subjUpper }));
      }
    }

    const item = Array.from(pdfStore.values()).find(p => p.id === id);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Item not found' }));
    }

    item.subject = subjUpper;

    if (item.localPath && fs.existsSync(item.localPath)) {
      const newFormatted = formatFilename(item.filename, item.deadlineTag, subjTitle, item.isDone);
      const newPath = path.join(targetDir, newFormatted);

      try {
        fs.renameSync(item.localPath, newPath);
        item.localPath = newPath;
        item.filename = newFormatted;
      } catch (err) {
        console.error('[Move Error]:', err.message);
      }
    }

    saveDatabase();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, subject: subjUpper, filename: item.filename, path: item.localPath }));
  }

  // 6. API: Download PDF to VERBAL or MATH folder
  if (parsedUrl.pathname === '/api/download') {
    const id = parsedUrl.searchParams.get('id');
    const targetFolder = (parsedUrl.searchParams.get('folder') || '').toUpperCase();
    const item = Array.from(pdfStore.values()).find(p => p.id === id);

    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found' }));
    }

    const chosenSubject = (targetFolder === 'MATH' || targetFolder === 'VERBAL') ? targetFolder : (item.subject || 'VERBAL');
    const destDir = chosenSubject === 'MATH' ? MATH_DIR : VERBAL_DIR;
    const todo = matchTodo(item.title, item.filename);
    const deadlineTag = getDeadlineTag(todo) || item.deadlineTag || '[17.10]';

    const formattedName = formatFilename(item.filename, deadlineTag, chosenSubject, item.isDone);

    try {
      let dest = path.join(destDir, formattedName);
      if (item.localPath && fs.existsSync(item.localPath) && !item.url) {
        if (path.resolve(item.localPath) !== path.resolve(dest)) {
          fs.renameSync(item.localPath, dest);
        }
      } else if (item.url) {
        await fetchFile(item.url, dest);
      }

      item.downloaded = true;
      item.subject = chosenSubject;
      item.filename = formattedName;
      item.localPath = dest;
      item.deadlineTag = deadlineTag;
      saveDatabase();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        success: true,
        subject: chosenSubject,
        path: dest,
        filename: formattedName
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 7. API: Toggle Done status & update Streak (supports both PDFs and Todos)
  if (parsedUrl.pathname === '/api/toggle-done') {
    const id = parsedUrl.searchParams.get('id');
    let item = Array.from(pdfStore.values()).find(p => p.id === id);
    let isTodo = false;
    let todo = null;

    if (!item && id && id.startsWith('todo_')) {
      const todoId = Number(id.replace('todo_', ''));
      todo = todoStore.get(todoId);
      if (todo) {
        isTodo = true;
        todo.isCompleted = !todo.isCompleted;
        item = { isDone: todo.isCompleted, filename: todo.title };
      }
    }

    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Item not found' }));
    }

    if (!isTodo) {
      item.isDone = !item.isDone;
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (!appSettings.streak) appSettings.streak = { count: 0, lastDoneDate: null, lastDoneTime: null, history: {} };
    if (!appSettings.streak.history) appSettings.streak.history = {};

    if (item.isDone) {
      item.doneAt = `${todayStr} ${timeStr}`;
      appSettings.streak.history[todayStr] = (appSettings.streak.history[todayStr] || 0) + 1;
      if (appSettings.streak.lastDoneDate === todayStr) {
        appSettings.streak.lastDoneTime = timeStr;
      } else {
        if (appSettings.streak.lastDoneDate) {
          const lastDate = new Date(appSettings.streak.lastDoneDate);
          const diffDays = Math.round((now - lastDate) / (1000 * 60 * 60 * 24));
          if (diffDays === 1) {
            appSettings.streak.count = (appSettings.streak.count || 0) + 1;
          } else {
            appSettings.streak.count = 1;
          }
        } else {
          appSettings.streak.count = 1;
        }
        appSettings.streak.lastDoneDate = todayStr;
        appSettings.streak.lastDoneTime = timeStr;
      }
    } else {
      if (appSettings.streak.history[todayStr] && appSettings.streak.history[todayStr] > 0) {
        appSettings.streak.history[todayStr]--;
      }
    }

    if (!isTodo && item.localPath && fs.existsSync(item.localPath)) {
      const dir = path.dirname(item.localPath);
      let newBase = formatFilename(item.filename, item.deadlineTag, item.subject || 'Verbal', item.isDone);
      const newPath = path.join(dir, newBase);

      if (item.localPath !== newPath) {
        try {
          fs.renameSync(item.localPath, newPath);
          item.localPath = newPath;
          item.filename = newBase;
        } catch (renameErr) {
          console.error('[Done Rename Error]:', renameErr.message);
        }
      }
    }

    saveDatabase();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      success: true,
      isDone: item.isDone,
      filename: item.filename,
      streak: appSettings.streak
    }));
  }

  // 8. API: Delete file (unlink from disk & remove from database or todoStore)
  if (parsedUrl.pathname === '/api/delete') {
    const id = parsedUrl.searchParams.get('id');

    if (id && id.startsWith('todo_')) {
      const todoId = Number(id.replace('todo_', ''));
      todoStore.delete(todoId);
      saveDatabase();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true, id }));
    }

    const item = Array.from(pdfStore.values()).find(p => p.id === id);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found' }));
    }

    if (item.localPath && fs.existsSync(item.localPath)) {
      try {
        fs.unlinkSync(item.localPath);
        console.log(`[x] ĐÃ XÓA FILE KHỎI Ổ ĐĨA: ${item.localPath}`);
      } catch (err) {
        console.error('Delete error:', err.message);
      }
    }

    pdfStore.delete(item.id);
    if (item.url) pdfStore.delete(item.url);
    saveDatabase();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, id }));
  }

  // 9. API: Set Personal / Custom Deadline (e.g. '2026-10-17')
  if (parsedUrl.pathname === '/api/set-custom-deadline') {
    const id = parsedUrl.searchParams.get('id');
    const date = (parsedUrl.searchParams.get('date') || '').trim();

    if (id && id.startsWith('todo_')) {
      const todoId = Number(id.replace('todo_', ''));
      const todo = todoStore.get(todoId);
      if (todo) {
        todo.customDeadline = date || null;
        saveDatabase();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, id, customDeadline: todo.customDeadline }));
      }
    }

    const item = Array.from(pdfStore.values()).find(p => p.id === id);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Item not found' }));
    }

    item.customDeadline = date || null;
    saveDatabase();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, id, customDeadline: item.customDeadline }));
  }

// Global batch state for mass fetching safe homework
let batchState = {
  isRunning: false,
  total: 0,
  current: 0,
  currentTitle: '',
  successCount: 0,
  skippedCount: 0,
  errorCount: 0,
  statusText: 'Sẵn sàng'
};


// Helper: Safely and reliably close ClassIn sub-window without closing main lobby or crashing ClassIn
async function closeClassInSubWindow(ws, subTargetId) {
  // CRITICAL: NEVER call fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${subTargetId}`) or window.close()
  // In CEF (ClassIn), /json/close kills CEF root process and crashes/closes the entire ClassIn application!
  
  // 1. If ws provided, execute internal clean close handlers
  if (ws && ws.readyState === 1) {
    try {
      await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(() => {
          // Method A: ClassIn LMS native module l2() (calls X.closeWindow() cleanly)
          try {
            let req;
            if (window.webpackChunklms) {
              window.webpackChunklms.push([[Symbol()], {}, (r) => { req = r; }]);
              if (req) {
                const m = req('39348');
                if (m && typeof m.l2 === 'function') { m.l2(); return 'm.l2()'; }
                if (m && typeof m.HT === 'function') { m.HT(); return 'm.HT()'; }
              }
            }
          } catch(e) {}

          // Method B: Qt WebChannel bridge closeSubWindow
          try {
            if (window.lmsBridge && typeof window.lmsBridge.closeSubWindow === 'function') {
              window.lmsBridge.closeSubWindow();
              return 'lmsBridge.closeSubWindow';
            }
          } catch(e) {}

          // Method C: Click titlebar close icon (.icon-close-hover)
          try {
            const btn = document.querySelector('.icon-close-hover, [class*="icon-close"]');
            if (btn) {
              btn.click();
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return 'icon-close-hover';
            }
          } catch(e) {}

          return 'none';
        })()`,
        returnByValue: true
      });
    } catch (err) {}
  } else if (subTargetId) {
    // If ws was not passed, connect briefly via WebSocket and trigger clean close
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) })).json();
      const target = targets.find(t => t.id === subTargetId);
      if (target && target.webSocketDebuggerUrl) {
        const tempWs = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise(r => { tempWs.onopen = r; setTimeout(r, 600); });
        if (tempWs.readyState === 1) {
          await cdpSend(tempWs, 'Runtime.evaluate', {
            expression: `(() => {
              try {
                let req;
                if (window.webpackChunklms) {
                  window.webpackChunklms.push([[Symbol()], {}, (r) => { req = r; }]);
                  if (req) {
                    const m = req('39348');
                    if (m && typeof m.l2 === 'function') { m.l2(); return 'm.l2()'; }
                  }
                }
              } catch(e) {}
              try {
                if (window.lmsBridge && typeof window.lmsBridge.closeSubWindow === 'function') {
                  window.lmsBridge.closeSubWindow();
                  return 'lmsBridge.closeSubWindow';
                }
              } catch(e) {}
              try {
                const btn = document.querySelector('.icon-close-hover');
                if (btn) { btn.click(); return 'btn.click'; }
              } catch(e) {}
            })()`
          });
          try { tempWs.close(); } catch(e) {}
        }
      }
    } catch(e) {}
  }

  // 2. Verify sub-window closed cleanly (NO /json/close!)
  for (let attempt = 1; attempt <= 8; attempt++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) })).json();
      if (!t.some(x => x.id === subTargetId)) {
        return true; // Target confirmed closed!
      }
    } catch(e) {}
  }
  return false;
}

// Core: Safe single task PDF fetcher (4-layer safety shield against timed exams)
async function fetchSingleTaskSafe(todo) {
  // LAYER 0: Skip non-downloadable assignment submission slots (Vở ghi, lớp học)
  if (isNonDownloadableTask(todo)) {
    return {
      success: false,
      isSkipped: true,
      message: `BỎ QUA: Bài "${todo.title}" là bài nộp vở ghi / lớp học, không có file đề thi PDF để tải.`
    };
  }

  // LAYER 1: Metadata & blacklist check (Zero tolerance for timed exams)
  if (isTimedExam(todo)) {
    return {
      success: false,
      isTimed: true,
      timeLimit: todo.timeLimit || 80,
      message: `BẢO VỆ TUYỆT ĐỐI: Bài "${todo.title}" là bài thi có tính giờ (${todo.timeLimit || 80} phút). Hệ thống đã khóa an toàn và tuyệt đối không mở để tránh bị tính giờ!`
    };
  }

  let targets = [];
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1000) });
    targets = await r.json();
  } catch {
    return { success: false, message: 'ClassIn chưa bật Port 9222. Vui lòng mở lại bằng file Khoi_Dong_ClassIn_De_Tai_PDF.bat!' };
  }

  const targetActivityId = todo.activityId ? String(todo.activityId) : null;

  // STEP 0: Check if any answersheet sub-windows are open.
  // If an answersheet window is open for a DIFFERENT activity, safely close it using native handler
  const openAnswersheets = targets.filter(t => t.url && t.url.includes('answersheet'));
  for (const win of openAnswersheets) {
    if (!targetActivityId || !win.url.includes(targetActivityId)) {
      console.log(`[FetchSafe] Đóng cửa sổ phụ cũ (${win.id}) trước khi lấy bài "${todo.title}"...`);
      await closeClassInSubWindow(null, win.id);
    }
  }

  // Refresh targets after cleanup
  try {
    const rClean = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1000) });
    targets = await rClean.json();
  } catch {}

  let answersheetTarget = targets.find(t => t.url && t.url.includes('answersheet') && (!targetActivityId || t.url.includes(targetActivityId)));

  // 1. If not open, find and click card in main lobby
  if (!answersheetTarget) {
    const mainTarget = targets.find(t => !t.url.includes('answersheet') && t.webSocketDebuggerUrl);
    if (!mainTarget) {
      return { success: false, message: 'Không tìm thấy cửa sổ sảnh ClassIn To-do' };
    }

    const wsMain = new WebSocket(mainTarget.webSocketDebuggerUrl);
    await new Promise(r => wsMain.onopen = r);

    const searchTarget = (todo.title || '').trim();

    const clickEval = await cdpSend(wsMain, 'Runtime.evaluate', {
      expression: `(() => {
        // Query only cards with base class to prevent duplicate matching
        const cards = Array.from(document.querySelectorAll('.baseTodoItem__D5dSs'));
        const target = ${JSON.stringify(searchTarget)}.trim().toLowerCase();
        
        let matchedCard = null;

        for (const card of cards) {
          const titleEl = card.querySelector('.text__Y7dUq.ellipsis__cZ4V6, .title__N9_tN, h3, h4');
          const cardTitle = (titleEl?.innerText || '').trim().toLowerCase();
          const fullText = (card.innerText || '').toLowerCase();
          const btnText = (card.querySelector('.button__EXmcJ')?.innerText || '').trim();

          // LAYER 2: Strictly exclude any timed exams, class sessions, or notebook photo slots
          if (fullText.includes('phút') || fullText.includes('bài thi') || cardTitle.includes('hw:') || cardTitle.includes('hw.') || cardTitle.includes('algebra') || cardTitle.includes('geometry') || cardTitle.includes('vở') || fullText.includes('vở') || btnText === 'Vào lớp') {
            continue;
          }

          // Strict normalized comparison (No loose .includes()!)
          const cleanCard = cardTitle.replace(/\\s+/g, ' ');
          const cleanTarget = target.replace(/\\s+/g, ' ');
          if (cleanCard === cleanTarget) {
            matchedCard = card;
            break;
          }
        }

        if (matchedCard) {
          matchedCard.scrollIntoView({ behavior: 'instant', block: 'center' });
          const btn = matchedCard.querySelector('.button__EXmcJ, [class*="button"]') || matchedCard;
          btn.click();
          return { clicked: true, title: matchedCard.querySelector('.text__Y7dUq')?.innerText };
        }
        return { clicked: false };
      })()`,
      returnByValue: true
    });

    wsMain.close();

    if (!clickEval?.result?.value?.clicked) {
      return { success: false, message: `Không tìm thấy thẻ bài tập "${todo.title}" trong sảnh ClassIn` };
    }

    // Poll up to 6 seconds for sub-window to open
    for (let poll = 0; poll < 12; poll++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r2 = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(800) });
        const targets2 = await r2.json();
        answersheetTarget = targets2.find(t => t.url && t.url.includes('answersheet') && (!targetActivityId || t.url.includes(targetActivityId)));
        if (answersheetTarget) break;
      } catch {}
    }
  }

  if (!answersheetTarget || !answersheetTarget.webSocketDebuggerUrl) {
    return { success: false, message: 'Không thể mở cửa sổ bài tập này trong ClassIn' };
  }

  // 2. Connect to sub-window
  let detectedPdfUrl = null;
  const wsAns = new WebSocket(answersheetTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    wsAns.onopen = resolve;
    wsAns.onerror = reject;
    setTimeout(() => reject(new Error('WS timeout')), 3500);
  });

  try {
    // Wait for React to render cover page or join page (up to 3.5 seconds)
    let pageState = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 350));
      const chk = await cdpSend(wsAns, 'Runtime.evaluate', {
        expression: `(() => {
          const text = (document.body.innerText || '').toLowerCase();
          const href = window.location.href.toLowerCase();
          const isJoinPage = href.includes('/join') || text.includes('đang làm bài thi') || text.includes('nộp');
          const hasTimer = /thời gian làm bài|đếm ngược|thời gian còn lại/i.test(text) || /\\b\\d+\\s*phút\\b/i.test(text);
          const isExplicitUntimed = text.includes('không có thời hạn');
          const isUntimed = isExplicitUntimed || (isJoinPage && !hasTimer) || (text.includes('tiếp tục') && !hasTimer);
          return { length: text.length, href, isJoinPage, isUntimed, hasTimer, isExplicitUntimed };
        })()`,
        returnByValue: true
      });
      if (chk?.result?.value && (chk.result.value.isUntimed || chk.result.value.hasTimer || i >= 8)) {
        pageState = chk.result.value;
        break;
      }
    }

    // LAYER 3: Strict check for timed exam
    if (pageState?.hasTimer || isTimedExam(todo)) {
      // Abort immediately and close window safely!
      await closeClassInSubWindow(wsAns, answersheetTarget.id);
      try { wsAns.close(); } catch(e) {}
      return {
        success: false,
        isTimed: true,
        message: `BẢO VỆ TUYỆT ĐỐI: Bài tập "${todo.title}" phát hiện giới hạn thời gian! Đã đóng cửa sổ ngay lập tức để bảo vệ bạn 100%!`
      };
    }

    // Verify it is untimed (either explicit text, join page without timer, or todo.timeLimit === 0)
    const isSafeUntimed = pageState?.isUntimed || ((todo.timeLimit || 0) === 0 && !pageState?.hasTimer);
    if (!isSafeUntimed) {
      await closeClassInSubWindow(wsAns, answersheetTarget.id);
      try { wsAns.close(); } catch(e) {}
      return {
        success: false,
        isTimed: true,
        message: 'BẢO VỆ TUYỆT ĐỐI: Không xác nhận được tính an toàn không giới hạn giờ! Đã đóng cửa sổ ngay lập tức!'
      };
    }

    // Safe! Enter assignment to trigger PDF loading
    const originalUrl = answersheetTarget.url;
    let currentUrl = pageState?.href || originalUrl;

    // STEP: Look for and click the "Bắt đầu" / "Tiếp tục" / "Làm bài" button
    if (!currentUrl.includes('/join')) {
      const clickStart = await cdpSend(wsAns, 'Runtime.evaluate', {
        expression: `(() => {
          const btns = Array.from(document.querySelectorAll('button, .ant-btn-primary, .ant-btn, [role="button"]'));
          const targetBtn = btns.find(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            return t === 'bắt đầu' || t === 'tiếp tục' || t === 'làm bài' || t.includes('bắt đầu') || t.includes('tiếp tục');
          });
          if (targetBtn) {
            targetBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            targetBtn.click();
            targetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { clicked: true, text: targetBtn.innerText.trim() };
          }
          return { clicked: false };
        })()`,
        returnByValue: true
      });

      console.log(`[FetchSafe] Bấm nút bắt đầu:`, clickStart?.result?.value);

      // If button not clicked and still on /detail, fallback to SPA navigate
      if (!clickStart?.result?.value?.clicked && currentUrl.includes('/detail')) {
        const joinUrl = currentUrl.replace('/answersheet/detail', '/answersheet/join');
        await cdpSend(wsAns, 'Page.navigate', { url: joinUrl });
      }
    }

    // Wait up to 8 seconds for PDF resource to load
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const perfRes = await cdpSend(wsAns, 'Runtime.evaluate', {
        expression: `(() => {
          const res = performance.getEntriesByType('resource').map(r => r.name);
          const pdfs = res.filter(url => url.toLowerCase().includes('.pdf') && !url.includes('.png'));
          if (pdfs.length > 0) return pdfs;
          const embeds = Array.from(document.querySelectorAll('iframe, embed, object')).map(e => e.src).filter(s => s && s.includes('.pdf'));
          return embeds;
        })()`,
        returnByValue: true
      });

      const found = perfRes?.result?.value || [];
      if (found.length > 0) {
        detectedPdfUrl = found[0];
        console.log(`[FetchSafe] Bắt được file PDF: ${detectedPdfUrl}`);
        break;
      }
    }

    // AUTOMATICALLY & SAFELY CLOSE SUB-WINDOW USING NATIVE INTERNAL HANDLER (Never /json/close!)
    await closeClassInSubWindow(wsAns, answersheetTarget.id);
    try { wsAns.close(); } catch(e) {}
  } catch (winErr) {
    try { await closeClassInSubWindow(wsAns, answersheetTarget?.id); wsAns.close(); } catch {}
    return { success: false, message: 'Lỗi nạp bài: ' + winErr.message };
  }

  if (detectedPdfUrl) {
    const subj = detectSubject(todo.title);
    const destDir = subj === 'MATH' ? MATH_DIR : VERBAL_DIR;
    const deadlineTag = todo.deadlineTag || (subj === 'MATH' ? '[21.10]' : '[17.10]');
    const filename = formatFilename(todo.title, deadlineTag, subj, false);
    const destPath = path.join(destDir, filename);

    await fetchFile(detectedPdfUrl, destPath);

    const pdfId = crypto.createHash('md5').update(detectedPdfUrl).digest('hex');
    pdfStore.set(pdfId, {
      id: pdfId,
      filename: filename,
      title: todo.title,
      url: detectedPdfUrl,
      subject: subj,
      recommendedSubject: subj,
      deadlineTag: deadlineTag,
      deadlineDate: todo.deadlineDate || '',
      customDeadline: todo.customDeadline || null,
      detectedAt: new Date().toLocaleTimeString('vi-VN'),
      downloaded: true,
      isDone: false,
      localPath: destPath
    });
    indexLocalFolders();
    matchAllTodos();
    saveDatabase();

    return { success: true, filename, path: destPath, url: detectedPdfUrl };
  }

  return { success: false, message: 'Không bắt được link PDF từ ClassIn' };
}

// Background Batch Mass Fetch runner (100% safe, skips all timed tests & submission slots)
async function runBatchFetchSafe() {
  if (batchState.isRunning) return;

  // STRICT FILTER: Only tasks that do NOT have a file AND are 100% NOT timed exams AND NOT non-downloadable AND NOT marked as noPdf!
  const items = getMergedItems().filter(i => !i.hasFile && !isTimedExam(i) && !isNonDownloadableTask(i) && !i.noPdf);
  batchState.isRunning = true;
  batchState.total = items.length;
  batchState.current = 0;
  batchState.successCount = 0;
  batchState.skippedCount = 0;
  batchState.errorCount = 0;
  batchState.statusText = `Đang bắt đầu lấy ${items.length} bài không tính giờ...`;

  for (const item of items) {
    if (!batchState.isRunning) {
      batchState.statusText = 'Đã dừng tự động lấy theo yêu cầu';
      break;
    }

    batchState.current++;
    batchState.currentTitle = item.title;
    batchState.statusText = `[${batchState.current}/${batchState.total}] Đang xử lý: ${item.title}`;

    try {
      const res = await fetchSingleTaskSafe(item);
      if (res.success) {
        batchState.successCount++;
        batchState.statusText = `[${batchState.current}/${batchState.total}] Đã lấy xong: ${item.title}`;
      } else if (res.isTimed) {
        batchState.skippedCount++;
        batchState.statusText = `[${batchState.current}/${batchState.total}] Bỏ qua (bài thi tính giờ): ${item.title}`;
      } else {
        batchState.skippedCount++;
        batchState.statusText = `[${batchState.current}/${batchState.total}] Bỏ qua (không có PDF): ${item.title}`;
        if (!appSettings.skippedNoPdf) appSettings.skippedNoPdf = [];
        const normKey = normalizeTitle(item.title);
        if (!appSettings.skippedNoPdf.includes(normKey)) appSettings.skippedNoPdf.push(normKey);
        if (item.todoId && !appSettings.skippedNoPdf.includes(item.todoId)) appSettings.skippedNoPdf.push(item.todoId);
        saveDatabase();
      }
    } catch (e) {
      batchState.skippedCount++;
      batchState.statusText = `[${batchState.current}/${batchState.total}] Lỗi & bỏ qua: ${item.title}`;
      if (!appSettings.skippedNoPdf) appSettings.skippedNoPdf = [];
      const normKey = normalizeTitle(item.title);
      if (!appSettings.skippedNoPdf.includes(normKey)) appSettings.skippedNoPdf.push(normKey);
      saveDatabase();
    }

    // Pause 1.5s between tasks so ClassIn lobby is responsive and screen stays clean
    await new Promise(r => setTimeout(r, 1500));
  }

  batchState.isRunning = false;
  batchState.statusText = `Hoàn tất! Đã lấy ${batchState.successCount}/${batchState.total} bài an toàn.`;
}

  // 9.1 API: Safe Single Task PDF Fetch
  if (parsedUrl.pathname === '/api/fetch-task-pdf') {
    const id = parsedUrl.searchParams.get('id');
    let todo = null;
    if (id && id.startsWith('todo_')) {
      todo = todoStore.get(Number(id.replace('todo_', '')));
    } else {
      todo = Array.from(todoStore.values()).find(t => t.id == id || t.activityId == id);
    }

    if (!todo) {
      const pdfItem = Array.from(pdfStore.values()).find(p => p.id === id);
      if (pdfItem) {
        todo = matchTodo(pdfItem.title, pdfItem.filename) || pdfItem;
      }
    }

    if (!todo) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Không tìm thấy thông tin bài tập này' }));
    }

    const result = await fetchSingleTaskSafe(todo);
    if (!result.success && !result.isTimed) {
      // Mark as skipped/noPdf
      if (!appSettings.skippedNoPdf) appSettings.skippedNoPdf = [];
      const normKey = normalizeTitle(todo.title);
      if (!appSettings.skippedNoPdf.includes(normKey)) appSettings.skippedNoPdf.push(normKey);
      if (todo.id && !appSettings.skippedNoPdf.includes(todo.id)) appSettings.skippedNoPdf.push(todo.id);
      saveDatabase();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // 9.1b API: Retry Single Task PDF (clears skipped status first)
  if (parsedUrl.pathname === '/api/retry-task-pdf') {
    const id = parsedUrl.searchParams.get('id');
    let todo = null;
    if (id && id.startsWith('todo_')) {
      todo = todoStore.get(Number(id.replace('todo_', '')));
    } else {
      todo = Array.from(todoStore.values()).find(t => t.id == id || t.activityId == id);
    }

    if (todo && appSettings.skippedNoPdf) {
      const normKey = normalizeTitle(todo.title);
      appSettings.skippedNoPdf = appSettings.skippedNoPdf.filter(k => k !== normKey && k !== todo.id && k !== ('todo_' + todo.id));
      saveDatabase();
    }

    if (!todo) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Không tìm thấy thông tin bài tập này' }));
    }

    const result = await fetchSingleTaskSafe(todo);
    if (!result.success && !result.isTimed) {
      if (!appSettings.skippedNoPdf) appSettings.skippedNoPdf = [];
      const normKey = normalizeTitle(todo.title);
      if (!appSettings.skippedNoPdf.includes(normKey)) appSettings.skippedNoPdf.push(normKey);
      if (todo.id && !appSettings.skippedNoPdf.includes(todo.id)) appSettings.skippedNoPdf.push(todo.id);
      saveDatabase();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // 9.2 API: Start Batch Mass Fetch for Safe Homeworks
  if (parsedUrl.pathname === '/api/batch-fetch-safe') {
    if (!batchState.isRunning) {
      runBatchFetchSafe();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, message: 'Đã bắt đầu tự động lấy bài tập an toàn!', state: batchState }));
  }

  // 9.3 API: Get Batch Fetch Status
  if (parsedUrl.pathname === '/api/batch-fetch-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(batchState));
  }

  // 9.4 API: Stop Batch Fetch
  if (parsedUrl.pathname === '/api/batch-fetch-stop') {
    batchState.isRunning = false;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh dừng lấy tự động.' }));
  }

  // 9.5 API: Save Manual File Group (Drag & Drop persistence)
  if (parsedUrl.pathname === '/api/save-file-group') {
    const fileId = parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('fileId');
    const groupId = parsedUrl.searchParams.get('groupId');
    if (fileId) {
      if (!appSettings.manualFileGroups) appSettings.manualFileGroups = {};
      if (groupId && groupId !== 'auto') {
        appSettings.manualFileGroups[fileId] = groupId;
      } else {
        delete appSettings.manualFileGroups[fileId];
      }
      saveDatabase();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, manualFileGroups: appSettings.manualFileGroups }));
  }

  // 9.6 API: Create Custom Topic Folder
  if (parsedUrl.pathname === '/api/create-topic-folder') {
    const name = (parsedUrl.searchParams.get('name') || '').trim();
    const subject = (parsedUrl.searchParams.get('subject') || 'VERBAL').toUpperCase();
    if (name) {
      if (!appSettings.customTopicFolders) appSettings.customTopicFolders = [];
      const colors = ['badge-purple', 'badge-blue', 'badge-green', 'badge-orange', 'badge-yellow', 'badge-teal', 'badge-rose', 'badge-brown'];
      const badgeColor = colors[appSettings.customTopicFolders.length % colors.length];
      const newFolder = {
        id: 'custom_' + Date.now(),
        name: name.toUpperCase(),
        subject,
        badgeColor,
        isCustom: true
      };
      appSettings.customTopicFolders.push(newFolder);
      saveDatabase();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true, folder: newFolder }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Tên dạng bài không được để trống' }));
  }

  // 9.7 API: Delete Custom Topic Folder
  if (parsedUrl.pathname === '/api/delete-topic-folder') {
    const folderId = parsedUrl.searchParams.get('id');
    if (folderId && appSettings.customTopicFolders) {
      appSettings.customTopicFolders = appSettings.customTopicFolders.filter(f => f.id !== folderId);
      if (appSettings.manualFileGroups) {
        for (const k in appSettings.manualFileGroups) {
          if (appSettings.manualFileGroups[k] === folderId) {
            delete appSettings.manualFileGroups[k];
          }
        }
      }
      saveDatabase();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true }));
  }

  // 10. API: App Settings (Exam countdown date & streak)
  if (parsedUrl.pathname === '/api/settings') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.examDate) appSettings.examDate = parsed.examDate;
          if (parsed.examTitle) appSettings.examTitle = parsed.examTitle;
          saveDatabase();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, settings: appSettings }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    const examDate = parsedUrl.searchParams.get('examDate');
    const examTitle = parsedUrl.searchParams.get('examTitle');
    if (examDate) appSettings.examDate = examDate;
    if (examTitle) appSettings.examTitle = examTitle;
    if (examDate || examTitle) saveDatabase();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(appSettings));
  }

  // 10.1 API: Habits & Habit Heatmap
  if (parsedUrl.pathname === '/api/habits') {
    if (!appSettings.habits) {
      appSettings.habits = {
        list: [
          { id: 'h_1', title: 'Dậy 4h00 sáng', category: 'Morning' },
          { id: 'h_2', title: 'Thiền 15 phút', category: 'Mindset' },
          { id: 'h_3', title: 'Tập Gym', category: 'Health' },
          { id: 'h_4', title: 'Học 4h SAT', category: 'Study' },
          { id: 'h_5', title: 'Học môn trên trường', category: 'School' },
          { id: 'h_6', title: 'Kỷ luật bản thân (Không fap/lọ)', category: 'Discipline' }
        ],
        history: {}
      };
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { action, id, title, category, date } = parsed;

          if (action === 'toggle') {
            const d = date || new Date().toISOString().slice(0, 10);
            if (!appSettings.habits.history) appSettings.habits.history = {};
            if (!Array.isArray(appSettings.habits.history[d])) appSettings.habits.history[d] = [];

            const idx = appSettings.habits.history[d].indexOf(id);
            if (idx >= 0) {
              appSettings.habits.history[d].splice(idx, 1);
            } else {
              appSettings.habits.history[d].push(id);
            }
          } else if (action === 'add' && title && title.trim()) {
            const newHabit = {
              id: 'h_' + Date.now(),
              title: title.trim(),
              category: (category || 'Chung').trim()
            };
            appSettings.habits.list.push(newHabit);
          } else if (action === 'edit' && id) {
            const h = appSettings.habits.list.find(item => item.id === id);
            if (h) {
              if (title) h.title = title.trim();
              if (category) h.category = category.trim();
            }
          } else if (action === 'delete' && id) {
            appSettings.habits.list = appSettings.habits.list.filter(item => item.id !== id);
            for (const d of Object.keys(appSettings.habits.history || {})) {
              appSettings.habits.history[d] = (appSettings.habits.history[d] || []).filter(item => item !== id);
            }
          }

          saveDatabase();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, habits: appSettings.habits }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(appSettings.habits));
  }

  // 10.2 API: Daily Planner & YPT Focus Timer
  if (parsedUrl.pathname === '/api/daily-todos') {
    if (!appSettings.dailyPlanner) {
      appSettings.dailyPlanner = { tasks: [], daysHistory: {}, activeTimer: null };
    }
    if (!appSettings.dailyPlanner.daysHistory) appSettings.dailyPlanner.daysHistory = {};

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { action, id, title, section, date, deadline, status } = parsed;

          if (!Array.isArray(appSettings.dailyPlanner.tasks)) {
            appSettings.dailyPlanner.tasks = [];
          }

          if (action === 'add' && title && title.trim()) {
            const newTask = {
              id: 'dp_' + Date.now(),
              title: title.trim(),
              section: section || 'morning',
              date: date || new Date().toISOString().slice(0, 10),
              deadline: deadline || '',
              completed: false,
              status: 'incomplete', // 'incomplete' | 'partial' | 'completed'
              spentSeconds: 0,
              createdAt: new Date().toISOString()
            };
            appSettings.dailyPlanner.tasks.push(newTask);
          } else if (action === 'set-status' && id) {
            const t = appSettings.dailyPlanner.tasks.find(item => item.id === id);
            if (t) {
              t.status = status || 'incomplete';
              t.completed = (t.status === 'completed');
              if (t.completed) {
                t.completedAt = new Date().toISOString();
                if (appSettings.dailyPlanner.activeTimer?.taskId === id) {
                  const prev = appSettings.dailyPlanner.activeTimer;
                  const sessionSec = Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000));
                  t.spentSeconds = (t.spentSeconds || 0) + sessionSec;
                  if (!appSettings.dailyPlanner.daysHistory[prev.date]) {
                    appSettings.dailyPlanner.daysHistory[prev.date] = { totalSeconds: 0, maxFocusSeconds: 0 };
                  }
                  appSettings.dailyPlanner.daysHistory[prev.date].totalSeconds += sessionSec;
                  appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds = Math.max(
                    appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds || 0,
                    sessionSec
                  );
                  appSettings.dailyPlanner.activeTimer = null;
                }
              } else {
                t.completedAt = null;
              }
            }
          } else if (action === 'start-timer' && id) {
            const t = appSettings.dailyPlanner.tasks.find(item => item.id === id);
            if (t) {
              const taskDate = date || t.date || new Date().toISOString().slice(0, 10);
              // If an active timer is already running on another task, stop & record it
              if (appSettings.dailyPlanner.activeTimer) {
                const prev = appSettings.dailyPlanner.activeTimer;
                const sessionSec = Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000));
                const prevTask = appSettings.dailyPlanner.tasks.find(item => item.id === prev.taskId);
                if (prevTask) {
                  prevTask.spentSeconds = (prevTask.spentSeconds || 0) + sessionSec;
                }
                if (!appSettings.dailyPlanner.daysHistory[prev.date]) {
                  appSettings.dailyPlanner.daysHistory[prev.date] = { totalSeconds: 0, maxFocusSeconds: 0 };
                }
                appSettings.dailyPlanner.daysHistory[prev.date].totalSeconds += sessionSec;
                appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds = Math.max(
                  appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds || 0,
                  sessionSec
                );
              }

              appSettings.dailyPlanner.activeTimer = {
                taskId: t.id,
                taskTitle: t.title,
                startedAt: Date.now(),
                date: taskDate
              };
            }
          } else if (action === 'stop-timer') {
            if (appSettings.dailyPlanner.activeTimer) {
              const prev = appSettings.dailyPlanner.activeTimer;
              const sessionSec = Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000));
              const targetTask = appSettings.dailyPlanner.tasks.find(item => item.id === prev.taskId);
              if (targetTask) {
                targetTask.spentSeconds = (targetTask.spentSeconds || 0) + sessionSec;
              }
              if (!appSettings.dailyPlanner.daysHistory[prev.date]) {
                appSettings.dailyPlanner.daysHistory[prev.date] = { totalSeconds: 0, maxFocusSeconds: 0 };
              }
              appSettings.dailyPlanner.daysHistory[prev.date].totalSeconds += sessionSec;
              appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds = Math.max(
                appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds || 0,
                sessionSec
              );
              appSettings.dailyPlanner.activeTimer = null;
            }
          } else if (action === 'toggle' && id) {
            const t = appSettings.dailyPlanner.tasks.find(item => item.id === id);
            if (t) {
              t.completed = !t.completed;
              t.status = t.completed ? 'completed' : 'incomplete';
              if (t.completed) {
                t.completedAt = new Date().toISOString();
                if (appSettings.dailyPlanner.activeTimer?.taskId === id) {
                  const prev = appSettings.dailyPlanner.activeTimer;
                  const sessionSec = Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000));
                  t.spentSeconds = (t.spentSeconds || 0) + sessionSec;
                  if (!appSettings.dailyPlanner.daysHistory[prev.date]) {
                    appSettings.dailyPlanner.daysHistory[prev.date] = { totalSeconds: 0, maxFocusSeconds: 0 };
                  }
                  appSettings.dailyPlanner.daysHistory[prev.date].totalSeconds += sessionSec;
                  appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds = Math.max(
                    appSettings.dailyPlanner.daysHistory[prev.date].maxFocusSeconds || 0,
                    sessionSec
                  );
                  appSettings.dailyPlanner.activeTimer = null;
                }
              } else {
                t.completedAt = null;
              }
            }
          } else if (action === 'edit' && id) {
            const t = appSettings.dailyPlanner.tasks.find(item => item.id === id);
            if (t) {
              if (title !== undefined) t.title = title.trim();
              if (section !== undefined) t.section = section;
              if (deadline !== undefined) t.deadline = deadline;
              if (date !== undefined) t.date = date;
              if (status !== undefined) {
                t.status = status;
                t.completed = (status === 'completed');
              }
            }
          } else if (action === 'delete' && id) {
            if (appSettings.dailyPlanner.activeTimer?.taskId === id) {
              appSettings.dailyPlanner.activeTimer = null;
            }
            appSettings.dailyPlanner.tasks = appSettings.dailyPlanner.tasks.filter(item => item.id !== id);
          }

          syncDiscordPresenceFromActiveTimer(true);
          saveDatabase();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, dailyPlanner: appSettings.dailyPlanner }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(appSettings.dailyPlanner));
  }

  // 10.3 API: Discord Rich Presence (Status, Config, Test)
  if (parsedUrl.pathname === '/api/discord-rpc') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!appSettings.discordRpc) appSettings.discordRpc = {};

          const prevClientId = appSettings.discordRpc.clientId;
          const prevEnabled = appSettings.discordRpc.enabled;

          if (parsed.enabled !== undefined) appSettings.discordRpc.enabled = !!parsed.enabled;
          if (parsed.clientId) appSettings.discordRpc.clientId = parsed.clientId.trim();
          if (parsed.activityType !== undefined) appSettings.discordRpc.activityType = Number(parsed.activityType);
          if (parsed.mode !== undefined) appSettings.discordRpc.mode = parsed.mode;
          if (parsed.stateFormat !== undefined) appSettings.discordRpc.stateFormat = parsed.stateFormat;
          if (parsed.customState !== undefined) appSettings.discordRpc.customState = parsed.customState.trim();
          if (parsed.largeImageStudy !== undefined) appSettings.discordRpc.largeImageStudy = parsed.largeImageStudy.trim();
          if (parsed.largeImageRest !== undefined) appSettings.discordRpc.largeImageRest = parsed.largeImageRest.trim();
          if (parsed.smallIconStudy !== undefined) appSettings.discordRpc.smallIconStudy = parsed.smallIconStudy.trim();
          if (parsed.smallIconRest !== undefined) appSettings.discordRpc.smallIconRest = parsed.smallIconRest.trim();
          if (parsed.smallTextStudy !== undefined) appSettings.discordRpc.smallTextStudy = parsed.smallTextStudy.trim();
          if (parsed.smallTextRest !== undefined) appSettings.discordRpc.smallTextRest = parsed.smallTextRest.trim();
          if (parsed.studyTitle !== undefined) appSettings.discordRpc.studyTitle = parsed.studyTitle.trim();
          if (parsed.restTitle !== undefined) appSettings.discordRpc.restTitle = parsed.restTitle.trim();
          if (parsed.largeText !== undefined) appSettings.discordRpc.largeText = parsed.largeText.trim();
          if (parsed.showTimer !== undefined) appSettings.discordRpc.showTimer = !!parsed.showTimer;

          saveDatabase();

          const clientIdChanged = parsed.clientId && parsed.clientId.trim() !== prevClientId;
          const enabledChanged = parsed.enabled !== undefined && !!parsed.enabled !== prevEnabled;

          if (clientIdChanged || enabledChanged) {
            disconnectDiscordIpc();
            if (appSettings.discordRpc.enabled) {
              initDiscordIpc();
            }
          }

          if (parsed.testNow) {
            clearTimeout(discordTestClearTimer);
            const sendTest = () => {
              const active = appSettings.dailyPlanner?.activeTimer;
              const todaySec = getTodayStudySeconds();
              const largeImg = active
                ? (appSettings.discordRpc.largeImageStudy || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=512&auto=format&fit=crop&q=80')
                : (appSettings.discordRpc.largeImageRest || 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=512&auto=format&fit=crop&q=80');
              const smallImg = active
                ? (appSettings.discordRpc.smallIconStudy || 'https://cdn-icons-png.flaticon.com/512/785/785116.png')
                : (appSettings.discordRpc.smallIconRest || 'https://cdn-icons-png.flaticon.com/512/924/924514.png');
              const smallTxt = active
                ? (appSettings.discordRpc.smallTextStudy || 'Focusing')
                : (appSettings.discordRpc.smallTextRest || 'Resting');
              const taskObj = active ? (appSettings.dailyPlanner?.tasks || []).find(t => t.id === active.taskId) : null;
              const taskElapsed = active ? ((taskObj?.spentSeconds || 0) + Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))) : 70;
              const testState = active
                ? `${formatTaskElapsed(taskElapsed)} - Total: ${formatTotalStudy(todaySec)}`
                : `Total: ${formatTotalStudy(todaySec)}`;

              updateDiscordActivity({
                type: Number(appSettings.discordRpc.activityType !== undefined ? appSettings.discordRpc.activityType : 3),
                details: active ? (appSettings.discordRpc.studyTitle || active.taskTitle || 'FOCUS') : (appSettings.discordRpc.restTitle || 'REST'),
                state: testState,
                timestamps: {
                  start: Math.floor((Date.now() - (active ? (appSettings.discordRpc?.mode === 'task' ? taskElapsed * 1000 : todaySec * 1000) : 60000)) / 1000)
                },
                assets: {
                  large_image: largeImg,
                  large_text: (appSettings.discordRpc?.largeText && appSettings.discordRpc.largeText.trim()) ? appSettings.discordRpc.largeText.trim() : undefined,
                  small_image: smallImg,
                  small_text: smallTxt
                },
                instance: true
              }, true);
            };
            if (clientIdChanged || enabledChanged || !discordIpcConnected) {
              setTimeout(sendTest, 400);
            } else {
              sendTest();
            }

            // Revert back after 60s
            discordTestClearTimer = setTimeout(() => {
              syncDiscordPresenceFromActiveTimer(true);
            }, 60000);
          } else if (!clientIdChanged && !enabledChanged) {
            syncDiscordPresenceFromActiveTimer(true);
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            success: true,
            config: appSettings.discordRpc,
            connected: discordIpcConnected,
            user: discordUserInfo
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    const todaySec = getTodayStudySeconds();
    const active = appSettings.dailyPlanner?.activeTimer;
    const taskObj = active ? (appSettings.dailyPlanner?.tasks || []).find(t => t.id === active.taskId) : null;
    const taskElapsedSec = active ? ((taskObj?.spentSeconds || 0) + Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))) : 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      enabled: !!appSettings.discordRpc?.enabled,
      connected: discordIpcConnected,
      user: discordUserInfo,
      clientId: appSettings.discordRpc?.clientId || '902536560539484202',
      activityType: Number(appSettings.discordRpc?.activityType !== undefined ? appSettings.discordRpc.activityType : 3),
      mode: appSettings.discordRpc?.mode || 'cumulative',
      stateFormat: appSettings.discordRpc?.stateFormat || 'today_stats',
      customState: appSettings.discordRpc?.customState || '',
      largeImageStudy: appSettings.discordRpc?.largeImageStudy || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=512&auto=format&fit=crop&q=80',
      largeImageRest: appSettings.discordRpc?.largeImageRest || 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=512&auto=format&fit=crop&q=80',
      smallIconStudy: appSettings.discordRpc?.smallIconStudy || 'https://cdn-icons-png.flaticon.com/512/785/785116.png',
      smallIconRest: appSettings.discordRpc?.smallIconRest || 'https://cdn-icons-png.flaticon.com/512/924/924514.png',
      smallTextStudy: appSettings.discordRpc?.smallTextStudy || 'Focusing',
      smallTextRest: appSettings.discordRpc?.smallTextRest || 'Resting',
      studyTitle: appSettings.discordRpc?.studyTitle || '',
      restTitle: appSettings.discordRpc?.restTitle || 'REST',
      largeText: appSettings.discordRpc?.largeText || '',
      showTimer: appSettings.discordRpc?.showTimer !== false,
      activeTask: active?.taskTitle || null,
      isRest: !active,
      todayTotalSeconds: todaySec,
      currentTaskElapsedSeconds: taskElapsedSec,
      formattedTaskElapsed: formatTaskElapsed(taskElapsedSec),
      formattedTotalStudy: formatTotalStudy(todaySec)
    }));
  }

  // 11. API: Standardize all local filenames to [DD.MM] [Subject] Name.pdf
  if (parsedUrl.pathname === '/api/standardize-all') {
    matchAllTodos();
    let renamedCount = 0;

    for (const item of pdfStore.values()) {
      if (item.localPath && fs.existsSync(item.localPath)) {
        const dir = path.dirname(item.localPath);
        const subj = item.subject || 'VERBAL';
        const deadline = item.deadlineTag || '[17.10]';
        const formatted = formatFilename(item.filename, deadline, subj, item.isDone);

        const newPath = path.join(dir, formatted);
        if (item.localPath !== newPath) {
          try {
            fs.renameSync(item.localPath, newPath);
            item.localPath = newPath;
            item.filename = formatted;
            renamedCount++;
          } catch (e) {
            console.error('Rename error:', e.message);
          }
        }
      }
    }

    saveDatabase();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, count: renamedCount }));
  }

  // 12. API: Open folder in Windows Explorer reliably via PowerShell
  if (parsedUrl.pathname === '/api/open-folder') {
    const target = (parsedUrl.searchParams.get('folder') || 'ALL').toUpperCase();
    let folderToOpen = BASE_10SAT;
    if (target === 'VERBAL') folderToOpen = VERBAL_DIR;
    else if (target === 'MATH') folderToOpen = MATH_DIR;

    const cmd = `powershell.exe -NoProfile -Command "Start-Process explorer.exe '${folderToOpen}'"`;
    exec(cmd, (err) => {
      if (err) console.error('Explorer error:', err);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, folder: folderToOpen }));
  }

  // 13. API: Get open ClassIn targets/windows
  if (parsedUrl.pathname === '/api/targets') {
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1000) });
      const targets = await resp.json();
      const pages = targets.filter(t => t.type === 'page').map(t => {
        let cleanTitle = t.title || 'Cửa sổ ClassIn';
        if (t.url.includes('/unhandled') || t.url.includes('/todo')) {
          cleanTitle = 'Sảnh To-do ClassIn';
        } else if (t.url.includes('/answersheet')) {
          cleanTitle = 'Chi tiết bài tập (Answer Sheet)';
        } else if (t.url.includes('/homework')) {
          cleanTitle = 'Chi tiết bài tập về nhà';
        }
        return {
          id: t.id,
          title: cleanTitle,
          rawTitle: t.title,
          url: t.url,
          wsUrl: t.webSocketDebuggerUrl,
          devtoolsUrl: `http://localhost:${CDP_PORT}${t.devtoolsFrontendUrl || ''}`
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(pages));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([]));
    }
  }

  // Static Avatar Image
  if (parsedUrl.pathname === '/elias_avatar.jpg') {
    const imgPath = path.join(__dirname, 'elias_avatar.jpg');
    if (fs.existsSync(imgPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(imgPath));
    }
  }

  // PWA Manifest
  if (parsedUrl.pathname === '/manifest.json') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(fs.readFileSync(manifestPath));
    }
  }

  // PWA Service Worker
  if (parsedUrl.pathname === '/sw.js') {
    const swPath = path.join(__dirname, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(fs.readFileSync(swPath));
    }
  }

  // HTML Frontend
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

// Start server
server.listen(PORT, '0.0.0.0', async () => {
  loadDatabase();
  initDiscordIpc();
  indexLocalFolders();
  matchAllTodos();
  await autoDownloadMissingFiles();
  indexLocalFolders();
  console.log('--------------------------------------------------');
  console.log('                     ELIAS SAT 1600 HARDCORE WORKSPACE               ');
  console.log(` Local:    http://localhost:${PORT}`);
  console.log(` Storage:  ${BASE_10SAT}`);
  console.log(` Database: ${pdfStore.size} files | ${todoStore.size} tasks`);
  console.log(` Status:   Ready (Port ${PORT}, CDP 9222)`);
  console.log('--------------------------------------------------\n');
  scanClassIn();
});
