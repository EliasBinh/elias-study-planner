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
const IS_CLOUD_INSTANCE = !!process.env.RENDER;
const CLOUD_SYNC_URL = process.env.CLOUD_SYNC_URL || 'https://elias-study-planner-0dv6.onrender.com';

let cloudTimeOffset = 0; // Canonical CloudTime - Local LaptopTime

function getCanonicalNow() {
  if (IS_CLOUD_INSTANCE) return Date.now();
  return Date.now() + cloudTimeOffset;
}

// Helper: Lấy chuỗi ngày YYYY-MM-DD theo múi giờ Việt Nam (Asia/Ho_Chi_Minh)
function getVnDateStr(timestampOrDate = getCanonicalNow()) {
  try {
    const d = (timestampOrDate instanceof Date) ? timestampOrDate : new Date(timestampOrDate);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
  } catch (e) {
    const d = new Date(timestampOrDate);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

async function calibrateClockOffset() {
  if (IS_CLOUD_INSTANCE) return;
  try {
    const t0 = Date.now();
    const res = await fetch(`${CLOUD_SYNC_URL}/api/daily-todos`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const t1 = Date.now();
      const rtt = Math.max(0, t1 - t0);
      if (data.serverTime) {
        cloudTimeOffset = data.serverTime - Math.floor(t0 + rtt / 2);
        console.log(`[Clock Sync] Initial offset calibrated: ${cloudTimeOffset}ms (${(cloudTimeOffset / 1000).toFixed(2)}s)`);
      }
    }
  } catch (e) {
    // Non-blocking
  }
}

// Folders: Priority to in-repo data/10SAT for Cloud Render deployment & standalone execution, fallback to Downloads/10SAT
const REPO_10SAT = path.join(__dirname, 'data', '10SAT');
const USER_DOWNLOADS_10SAT = path.join(os.homedir(), 'Downloads', '10SAT');
const BASE_10SAT = (fs.existsSync(REPO_10SAT) && fs.existsSync(path.join(REPO_10SAT, 'VERBAL')))
  ? REPO_10SAT
  : USER_DOWNLOADS_10SAT;
const VERBAL_DIR = path.join(BASE_10SAT, 'VERBAL');
const MATH_DIR = path.join(BASE_10SAT, 'MATH');
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, 'database.json');

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
    history: {},
    deletedHabits: {},
    changedAt: 0
  },
  dailyPlanner: {
    tasks: [
      { id: 'dp_1', title: '1 câu trắc nghiệm toán cảnh', section: 'evening', completed: true, status: 'completed', date: '2026-10-22', deadline: '', spentSeconds: 0 }
    ],
    goals: [],
    deletedGoals: {},
    sessions: [],
    deletedSessions: {},
    calendarEvents: [],
    deletedCalendarEvents: {},
    scheduleSettings: {
      dayStartHour: 4,
      sleepEnabled: true,
      bedTime: '22:35',
      wakeTime: '04:45',
      showBreaks: true,
      minBreakSeconds: 60,
      updatedAt: 0
    },
    daysHistory: {},
    activeTimer: null,
    activeTimerChangedAt: 0,
    lastTimerStoppedAt: 0
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
function formatFilename(baseName, deadlineTag, subject = 'Verbal', isDone = false) {
  const clean = cleanBaseName(baseName || '');
  const subj = (subject || 'Verbal').toLowerCase() === 'math' ? 'Math' : 'Verbal';
  const tag = (deadlineTag || '[17.10]').replace(/Hạn\s*/i, '').replace('-', '.');
  let result = `${tag} [${subj}] ${clean}`;
  if (isDone) result = `[Done] ${result}`;
  return result.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// Universal PDF path resolver (Local Windows disk + Repo data folder)
function resolveLocalPdfPath(item) {
  if (!item) return null;
  const isMath = (item.subject || '').toUpperCase() === 'MATH';
  const isVerbal = (item.subject || '').toUpperCase() === 'VERBAL';

  // 1. Direct localPath if exists and matches subject directory
  if (item.localPath && fs.existsSync(item.localPath)) {
    const normPath = item.localPath.replace(/\\/g, '/');
    if (isMath && normPath.includes('/VERBAL/')) {
      // Discard wrong subject directory
    } else if (isVerbal && normPath.includes('/MATH/')) {
      // Discard wrong subject directory
    } else {
      return item.localPath;
    }
  }

  // 2. Candidate dirs restricted strictly by subject
  const candidateDirs = isMath
    ? [MATH_DIR, path.join(REPO_10SAT, 'MATH'), path.join(USER_DOWNLOADS_10SAT, 'MATH')]
    : [VERBAL_DIR, path.join(REPO_10SAT, 'VERBAL'), path.join(USER_DOWNLOADS_10SAT, 'VERBAL')];

  if (item.filename) {
    for (const d of candidateDirs) {
      if (!fs.existsSync(d)) continue;
      const direct = path.join(d, item.filename);
      if (fs.existsSync(direct)) return direct;
    }

    // Try matching by normalized clean basename
    const cleanTarget = cleanBaseName(item.filename).toLowerCase();
    for (const d of candidateDirs) {
      if (!fs.existsSync(d)) continue;
      try {
        const files = fs.readdirSync(d);
        const match = files.find(f => cleanBaseName(f).toLowerCase() === cleanTarget);
        if (match) return path.join(d, match);
      } catch (e) { }
    }
  }

  // Also try matching by title
  if (item.title) {
    const cleanTitle = cleanBaseName(item.title).toLowerCase();
    for (const d of candidateDirs) {
      if (!fs.existsSync(d)) continue;
      try {
        const files = fs.readdirSync(d);
        const match = files.find(f => cleanBaseName(f).replace(/\.pdf$/i, '').toLowerCase() === cleanTitle);
        if (match) return path.join(d, match);
      } catch (e) { }
    }
  }

  return null;
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
          habits: {
            list: Array.isArray(data.settings?.habits?.list) ? data.settings.habits.list : (appSettings.habits?.list || []),
            history: (typeof data.settings?.habits?.history === 'object' && data.settings?.habits?.history !== null) ? data.settings.habits.history : {},
            deletedHabits: (typeof data.settings?.habits?.deletedHabits === 'object' && data.settings?.habits?.deletedHabits !== null) ? data.settings.habits.deletedHabits : {},
            changedAt: data.settings?.habits?.changedAt || 0
          },
          dailyPlanner: {
            tasks: Array.isArray(data.settings?.dailyPlanner?.tasks) ? data.settings.dailyPlanner.tasks : (appSettings.dailyPlanner?.tasks || []),
            goals: Array.isArray(data.settings?.dailyPlanner?.goals) ? data.settings.dailyPlanner.goals : (appSettings.dailyPlanner?.goals || []),
            sessions: Array.isArray(data.settings?.dailyPlanner?.sessions) ? data.settings.dailyPlanner.sessions : [],
            calendarEvents: Array.isArray(data.settings?.dailyPlanner?.calendarEvents) ? data.settings.dailyPlanner.calendarEvents : [],
            scheduleSettings: normalizeScheduleSettings(data.settings?.dailyPlanner?.scheduleSettings),
            daysHistory: (typeof data.settings?.dailyPlanner?.daysHistory === 'object' && data.settings.dailyPlanner.daysHistory !== null) ? data.settings.dailyPlanner.daysHistory : (appSettings.dailyPlanner?.daysHistory || {}),
            deletedTasks: (typeof data.settings?.dailyPlanner?.deletedTasks === 'object' && data.settings.dailyPlanner.deletedTasks !== null) ? data.settings.dailyPlanner.deletedTasks : {},
            deletedGoals: (typeof data.settings?.dailyPlanner?.deletedGoals === 'object' && data.settings.dailyPlanner.deletedGoals !== null) ? data.settings.dailyPlanner.deletedGoals : {},
            activeTimer: data.settings?.dailyPlanner?.activeTimer || null,
            activeTimerChangedAt: data.settings?.dailyPlanner?.activeTimerChangedAt || 0,
            lastTimerStoppedAt: data.settings?.dailyPlanner?.lastTimerStoppedAt || 0,
            deletedSessions: (typeof data.settings?.dailyPlanner?.deletedSessions === 'object' && data.settings?.dailyPlanner?.deletedSessions !== null) ? data.settings.dailyPlanner.deletedSessions : {},
            deletedCalendarEvents: (typeof data.settings?.dailyPlanner?.deletedCalendarEvents === 'object' && data.settings?.dailyPlanner?.deletedCalendarEvents !== null) ? data.settings.dailyPlanner.deletedCalendarEvents : {}
          },
          discordRpc: {
            ...appSettings.discordRpc,
            ...(data.settings?.discordRpc || {})
          }
        };

        if (appSettings.dailyPlanner && Array.isArray(appSettings.dailyPlanner.tasks)) {
          for (const t of appSettings.dailyPlanner.tasks) {
            if (!t.updatedAt) {
              t.updatedAt = t.createdAt ? new Date(t.createdAt).getTime() : 1;
            }
            if (!t.status) {
              t.status = t.completed ? 'completed' : 'incomplete';
            }
          }
        }
        if (appSettings.dailyPlanner && Array.isArray(appSettings.dailyPlanner.sessions)) {
          appSettings.dailyPlanner.sessions = appSettings.dailyPlanner.sessions
            .filter(s => s && s.id && Number.isFinite(Number(s.startedAt)) && Number.isFinite(Number(s.endedAt)) && Number(s.endedAt) >= Number(s.startedAt))
            .map(s => {
              const startedAt = Number(s.startedAt);
              const endedAt = Number(s.endedAt);
              const meta = inferPlannerSubjectAndColor(s.title, s.subject, s.color);
              return {
                ...s,
                title: String(s.title || 'Focus').trim() || 'Focus',
                subject: meta.subject,
                color: meta.color,
                date: /^\d{4}-\d{2}-\d{2}$/.test(s.date || '') ? s.date : getVnDateStr(startedAt),
                startedAt,
                endedAt,
                durationSeconds: Number.isFinite(Number(s.durationSeconds)) ? Math.max(0, Math.round(Number(s.durationSeconds))) : Math.max(0, Math.floor((endedAt - startedAt) / 1000)),
                updatedAt: s.updatedAt || endedAt || Date.now()
              };
            });
        }
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

// Helper: Save database (Atomic Write + Debounced Dirty Flush)
// Atomic Write: Writes to a temp file first, then renames it to the real path.
// This guarantees the original file is never corrupted even if the process crashes mid-write.
// Debounced Flush: Coalesces rapid successive saves into a single disk write after 500ms of quiet.
let _dbDirty = false;
let _dbFlushTimer = null;

function _buildDatabasePayload() {
  return {
    updatedAt: new Date().toISOString(),
    settings: appSettings,
    items: Array.from(pdfStore.values()),
    todos: Array.from(todoStore.values())
  };
}

function _atomicWriteSync(filePath, content) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Windows file locking fallback (EPERM, EBUSY, EEXIST)
    if (['EPERM', 'EBUSY', 'EEXIST'].includes(err.code)) {
      try {
        fs.copyFileSync(tmpPath, filePath);
        try { fs.unlinkSync(tmpPath); } catch (_) { }
        return;
      } catch (copyErr) {
        fs.writeFileSync(filePath, content, 'utf-8');
        try { fs.unlinkSync(tmpPath); } catch (_) { }
        return;
      }
    }
    throw err;
  }
}

function _flushDatabase() {
  try {
    const content = JSON.stringify(_buildDatabasePayload(), null, 2);
    _atomicWriteSync(DB_FILE, content);
    _dbDirty = false;
  } catch (err) {
    console.error('[DB] Lỗi lưu database:', err.message);
    // Keep dirty flag and re-schedule retry so changes are never silently lost
    _dbDirty = true;
    if (!_dbFlushTimer) {
      _dbFlushTimer = setTimeout(() => {
        _dbFlushTimer = null;
        if (_dbDirty) _flushDatabase();
      }, 2000);
    }
  }
}

function saveDatabase() {
  _dbDirty = true;
  if (!_dbFlushTimer) {
    _dbFlushTimer = setTimeout(() => {
      _dbFlushTimer = null;
      if (_dbDirty) _flushDatabase();
    }, 500);
  }
}

// Ensure data is flushed on clean shutdown
function flushDatabaseSync() {
  if (_dbFlushTimer) {
    clearTimeout(_dbFlushTimer);
    _dbFlushTimer = null;
  }
  if (_dbDirty) _flushDatabase();
}
process.on('SIGINT', () => { flushDatabaseSync(); process.exit(0); });
process.on('SIGTERM', () => { flushDatabaseSync(); process.exit(0); });
process.on('exit', () => { flushDatabaseSync(); });

// Global Fault-Tolerant Process Error Shield (Keeps backend 100% resilient & 24/7 online)
process.on('uncaughtException', (err) => {
  console.error(`[Server Fault Shield] Uncaught Exception at ${new Date().toISOString()}:`, err);
  try { flushDatabaseSync(); } catch (_) { }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[Server Fault Shield] Unhandled Rejection at ${new Date().toISOString()}:`, reason);
});

// ========== Daily Planner Helpers: Timezone, Sessions, Timeline & LWW Sync ==========
const VN_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_TIMER_INCREMENT_SEC = 4 * 3600;
const DEFAULT_SCHEDULE_SETTINGS = {
  dayStartHour: 4,
  sleepEnabled: true,
  bedTime: '22:35',
  wakeTime: '04:45',
  showBreaks: true,
  minBreakSeconds: 60,
  updatedAt: 0
};
const SUBJECT_COLORS = {
  MATH: '#38BDF8',
  VERBAL: '#7DD3FC',
  PHYSICS: '#60A5FA',
  CHEM: '#93C5FD',
  WORKOUT: '#BAE6FD',
  OTHER: '#38BDF8'
};

function normalizeHHMM(val, fallback = '22:35') {
  const match = String(val || '').trim().match(/^(\d{1,2})[:hH](\d{1,2})$/);
  if (!match) return fallback;
  const h = Math.max(0, Math.min(23, parseInt(match[1], 10)));
  const m = Math.max(0, Math.min(59, parseInt(match[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeScheduleSettings(raw = {}) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const dayStartRaw = Number(src.dayStartHour);
  const minBreakRaw = Number(src.minBreakSeconds);
  return {
    dayStartHour: Number.isFinite(dayStartRaw) ? Math.max(0, Math.min(12, Math.round(dayStartRaw))) : DEFAULT_SCHEDULE_SETTINGS.dayStartHour,
    sleepEnabled: src.sleepEnabled !== undefined ? !!src.sleepEnabled : DEFAULT_SCHEDULE_SETTINGS.sleepEnabled,
    bedTime: normalizeHHMM(src.bedTime, DEFAULT_SCHEDULE_SETTINGS.bedTime),
    wakeTime: normalizeHHMM(src.wakeTime, DEFAULT_SCHEDULE_SETTINGS.wakeTime),
    showBreaks: src.showBreaks !== undefined ? !!src.showBreaks : DEFAULT_SCHEDULE_SETTINGS.showBreaks,
    minBreakSeconds: Number.isFinite(minBreakRaw) ? Math.max(10, Math.min(3600, Math.round(minBreakRaw))) : DEFAULT_SCHEDULE_SETTINGS.minBreakSeconds,
    updatedAt: Number(src.updatedAt) || 0
  };
}

function inferPlannerSubjectAndColor(title = '', explicitSubject = '', explicitColor = '') {
  const t = String(title || '').toLowerCase();
  let subject = String(explicitSubject || '').toUpperCase();
  if (!['MATH', 'VERBAL', 'PHYSICS', 'CHEM', 'WORKOUT', 'OTHER'].includes(subject)) {
    const mathRe = /\b(math|toán|algebra|geo|geometry|adv|advance|advanced|polynomial|equation|calculus|prob|probability|statistic|statistics|trig|trigonometry|function|graph|ratio|percent|angle|quadratic|linear|problem\s*solving|data\s*analysis)\b|câu\s*(geo|adv|prob|alg)/i;
    const verbalRe = /\b(verbal|ebrw|reading|writing|grammar|vocab|vocabulary|passage|transition|synthesis|inference|details|detail|main idea|structure|rhetoric|wic|word|english|critical)\b/i;
    const physRe = /\b(physics|vật\s*lý|l[ýy]\b)/i;
    const chemRe = /\b(chem|chemistry|h[óo]a\b)/i;
    const workoutRe = /\b(workout|gym|chạy\s*bộ|tập\s*thể|cardio)\b/i;
    if (mathRe.test(t) || t.includes('toán')) subject = 'MATH';
    else if (verbalRe.test(t) || t.includes('tiếng anh')) subject = 'VERBAL';
    else if (physRe.test(t)) subject = 'PHYSICS';
    else if (chemRe.test(t)) subject = 'CHEM';
    else if (workoutRe.test(t)) subject = 'WORKOUT';
    else subject = 'OTHER';
  }
  const cleanColor = /^#[0-9a-f]{3,8}$/i.test(String(explicitColor || '').trim()) ? String(explicitColor).trim() : '';
  return {
    subject,
    color: cleanColor || SUBJECT_COLORS[subject] || SUBJECT_COLORS.OTHER
  };
}

function vnDateTimeToMs(dateStr, hh = 0, mm = 0, addDays = 0) {
  const parts = String(dateStr || getVnDateStr()).split('-').map(Number);
  const y = parts[0] || 2026;
  const m = (parts[1] || 1) - 1;
  const d = (parts[2] || 1) + addDays;
  return Date.UTC(y, m, d, hh - 7, mm, 0, 0);
}

function msToVnParts(ts) {
  const vn = new Date(Number(ts) + VN_OFFSET_MS);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth() + 1;
  const d = vn.getUTCDate();
  const hours = vn.getUTCHours();
  const minutes = vn.getUTCMinutes();
  return {
    dateStr: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    hours,
    minutes,
    hhmm: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    totalMinutes: hours * 60 + minutes
  };
}

function ensureDailyPlannerShape(planner) {
  if (!planner || typeof planner !== 'object') return;
  if (!Array.isArray(planner.tasks)) planner.tasks = [];
  if (!Array.isArray(planner.goals)) planner.goals = [];
  if (!Array.isArray(planner.sessions)) planner.sessions = [];
  if (!Array.isArray(planner.calendarEvents)) planner.calendarEvents = [];
  if (!planner.daysHistory || typeof planner.daysHistory !== 'object') planner.daysHistory = {};
  if (!planner.deletedTasks || typeof planner.deletedTasks !== 'object') planner.deletedTasks = {};
  if (!planner.deletedGoals || typeof planner.deletedGoals !== 'object') planner.deletedGoals = {};
  if (!planner.deletedSessions || typeof planner.deletedSessions !== 'object') planner.deletedSessions = {};
  if (!planner.deletedCalendarEvents || typeof planner.deletedCalendarEvents !== 'object') planner.deletedCalendarEvents = {};
  planner.scheduleSettings = normalizeScheduleSettings(planner.scheduleSettings);
  if (planner.activeTimerChangedAt === undefined) planner.activeTimerChangedAt = 0;
  if (planner.lastTimerStoppedAt === undefined) planner.lastTimerStoppedAt = 0;
}

function filterDeletedEntities(list, deletedMap) {
  if (!Array.isArray(list)) return [];
  const del = deletedMap || {};
  return list.filter(item => {
    if (!item || !item.id) return false;
    const delTime = del[item.id];
    if (!delTime) return true;
    const updated = item.updatedAt || (item.createdAt ? new Date(item.createdAt).getTime() : 0);
    return updated > delTime;
  });
}

function buildPlannerPayload(planner) {
  ensureDailyPlannerShape(planner);
  return {
    ...planner,
    tasks: filterDeletedEntities(planner.tasks, planner.deletedTasks),
    goals: filterDeletedEntities(planner.goals, planner.deletedGoals),
    sessions: filterDeletedEntities(planner.sessions, planner.deletedSessions),
    calendarEvents: filterDeletedEntities(planner.calendarEvents, planner.deletedCalendarEvents),
    scheduleSettings: normalizeScheduleSettings(planner.scheduleSettings)
  };
}

function recomputeDayStatsFromSessions(planner, dateStr) {
  ensureDailyPlannerShape(planner);
  if (!dateStr) return;
  if (!planner.daysHistory[dateStr]) {
    planner.daysHistory[dateStr] = { totalSeconds: 0, maxFocusSeconds: 0 };
  }
  const dayEntry = planner.daysHistory[dateStr];
  dayEntry.totalSeconds = Math.max(0, Math.round(dayEntry.totalSeconds || 0));
  const activeSessions = filterDeletedEntities(planner.sessions, planner.deletedSessions).filter(s => s.date === dateStr);
  const maxSessionDur = activeSessions.reduce((mx, s) => Math.max(mx, s.durationSeconds || 0), 0);
  const sumSessionDur = activeSessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const unloggedLegacy = Math.max(0, dayEntry.totalSeconds - sumSessionDur);
  const maxTaskSpentOnDay = filterDeletedEntities(planner.tasks, planner.deletedTasks)
    .filter(t => (t.date || dateStr) === dateStr)
    .reduce((mx, t) => Math.max(mx, t.spentSeconds || 0), 0);
  const legacyMaxEstimate = unloggedLegacy > 0
    ? Math.min(unloggedLegacy, Math.max(maxTaskSpentOnDay, dayEntry.maxFocusSeconds || 0))
    : 0;
  dayEntry.maxFocusSeconds = Math.min(dayEntry.totalSeconds, Math.max(maxSessionDur, legacyMaxEstimate));
}

function upsertSessionRecord(planner, sessionObj) {
  ensureDailyPlannerShape(planner);
  if (!sessionObj || !sessionObj.id) return null;
  const delTime = planner.deletedSessions[sessionObj.id];
  if (delTime && delTime >= (sessionObj.updatedAt || 0)) return null;
  const idx = planner.sessions.findIndex(s => s.id === sessionObj.id);
  if (idx >= 0) {
    planner.sessions[idx] = { ...planner.sessions[idx], ...sessionObj };
    return planner.sessions[idx];
  }
  planner.sessions.push(sessionObj);
  return sessionObj;
}

function applyActiveTimerDelta(planner, now, mode = 'checkpoint') {
  ensureDailyPlannerShape(planner);
  if (!planner.activeTimer) return 0;
  const prev = planner.activeTimer;
  const rawSec = Math.max(0, Math.floor((now - prev.startedAt) / 1000));
  const sessionSec = Math.min(MAX_TIMER_INCREMENT_SEC, rawSec);
  const origStart = prev.sessionStartedAt || prev.startedAt;
  const continuousSec = Math.min(MAX_TIMER_INCREMENT_SEC, Math.max(0, Math.floor((now - origStart) / 1000)));
  const sessionId = prev.sessionId || ('ses_' + origStart + '_auto');
  const prevTask = planner.tasks.find(item => item.id === prev.taskId);

  if (prevTask && sessionSec > 0) {
    prevTask.spentSeconds = (prevTask.spentSeconds || 0) + sessionSec;
    prevTask.updatedAt = now;
  }

  const timerDate = prev.date || getVnDateStr(origStart);
  if (!planner.daysHistory[timerDate]) {
    planner.daysHistory[timerDate] = { totalSeconds: 0, maxFocusSeconds: 0 };
  }
  if (sessionSec > 0) {
    planner.daysHistory[timerDate].totalSeconds = (planner.daysHistory[timerDate].totalSeconds || 0) + sessionSec;
  }
  planner.daysHistory[timerDate].maxFocusSeconds = Math.max(
    planner.daysHistory[timerDate].maxFocusSeconds || 0,
    continuousSec,
    prevTask ? (prevTask.spentSeconds || 0) : 0
  );

  if ((mode === 'stop' && continuousSec >= 1) || (mode === 'checkpoint' && continuousSec >= 5)) {
    const title = prevTask?.title || prev.taskTitle || 'Focus';
    const meta = inferPlannerSubjectAndColor(title, prev.subject || prevTask?.subject, prev.color || prevTask?.color);
    upsertSessionRecord(planner, {
      id: sessionId,
      taskId: prev.taskId || null,
      title,
      subject: meta.subject,
      color: meta.color,
      date: timerDate,
      startedAt: origStart,
      endedAt: origStart + continuousSec * 1000,
      durationSeconds: continuousSec,
      source: 'timer',
      note: '',
      updatedAt: now
    });
  }

  if (mode === 'stop') {
    planner.activeTimer = null;
    planner.activeTimerChangedAt = now;
    planner.lastTimerStoppedAt = now;
  } else if (sessionSec > 0) {
    prev.sessionId = sessionId;
    prev.sessionStartedAt = origStart;
    prev.startedAt = now;
    planner.activeTimerChangedAt = now;
  }
  return continuousSec;
}

function resolveSleepWindowForDate(dateStr, scheduleSettings) {
  const sch = normalizeScheduleSettings(scheduleSettings);
  const [bH, bM] = sch.bedTime.split(':').map(Number);
  const [wH, wM] = sch.wakeTime.split(':').map(Number);
  const bedMin = bH * 60 + bM;
  const wakeMin = wH * 60 + wM;
  const bedAddDay = bedMin < sch.dayStartHour * 60 ? 1 : 0;
  const wakeAddDay = (wakeMin <= bedMin || bedAddDay > 0) ? (bedAddDay + (wakeMin <= bedMin ? 1 : 0)) : bedAddDay;
  const bedAtMs = vnDateTimeToMs(dateStr, bH, bM, bedAddDay);
  const wakeAtMs = vnDateTimeToMs(dateStr, wH, wM, wakeAddDay);
  return {
    enabled: sch.sleepEnabled,
    bedTime: sch.bedTime,
    wakeTime: sch.wakeTime,
    bedAtMs,
    wakeAtMs,
    durationSeconds: Math.max(0, Math.floor((wakeAtMs - bedAtMs) / 1000))
  };
}

function buildDayTimelineSummary(planner, dateStr, now = getCanonicalNow()) {
  ensureDailyPlannerShape(planner);
  const sch = normalizeScheduleSettings(planner.scheduleSettings);
  const todayStr = getVnDateStr(now);

  // Completed / checkpointed sessions for dateStr
  let sessions = filterDeletedEntities(planner.sessions, planner.deletedSessions)
    .filter(s => s.date === dateStr)
    .map(s => ({ ...s, isLive: false }));

  // Include / overlay active running timer if on dateStr
  const active = planner.activeTimer;
  if (active && active.date === dateStr) {
    const origStart = active.sessionStartedAt || active.startedAt;
    const liveEnd = Math.max(origStart, now);
    const liveDur = Math.min(MAX_TIMER_INCREMENT_SEC, Math.floor((liveEnd - origStart) / 1000));
    const taskObj = planner.tasks.find(t => t.id === active.taskId);
    const title = taskObj?.title || active.taskTitle || 'Focus';
    const meta = inferPlannerSubjectAndColor(title, active.subject || taskObj?.subject, active.color || taskObj?.color);
    const liveSessionId = active.sessionId || ('ses_' + origStart + '_auto');
    const existingIdx = sessions.findIndex(s => s.id === liveSessionId);
    const liveObj = {
      id: liveSessionId,
      taskId: active.taskId || null,
      title,
      subject: meta.subject,
      color: meta.color,
      date: dateStr,
      startedAt: origStart,
      endedAt: origStart + liveDur * 1000,
      durationSeconds: liveDur,
      source: 'timer',
      note: '',
      isLive: true,
      updatedAt: now
    };
    if (existingIdx >= 0) sessions[existingIdx] = liveObj;
    else sessions.push(liveObj);
  }

  sessions.sort((a, b) => a.startedAt - b.startedAt);

  // Merge overlapping intervals to accurately compute idle break gaps
  const mergedIntervals = [];
  for (const s of sessions) {
    if (s.endedAt <= s.startedAt) continue;
    if (mergedIntervals.length === 0 || s.startedAt > mergedIntervals[mergedIntervals.length - 1].endedAt) {
      mergedIntervals.push({ startedAt: s.startedAt, endedAt: s.endedAt });
    } else {
      mergedIntervals[mergedIntervals.length - 1].endedAt = Math.max(mergedIntervals[mergedIntervals.length - 1].endedAt, s.endedAt);
    }
  }

  const breaks = [];
  for (let i = 0; i < mergedIntervals.length - 1; i++) {
    const gapStart = mergedIntervals[i].endedAt;
    const gapEnd = mergedIntervals[i + 1].startedAt;
    const dur = Math.floor((gapEnd - gapStart) / 1000);
    if (dur >= sch.minBreakSeconds) {
      breaks.push({ startedAt: gapStart, endedAt: gapEnd, durationSeconds: dur, isOngoing: false });
    }
  }

  // Ongoing break after last study block if viewing Today & currently not studying
  let ongoingBreakSeconds = 0;
  if (dateStr === todayStr && !active && mergedIntervals.length > 0) {
    const lastEnd = mergedIntervals[mergedIntervals.length - 1].endedAt;
    if (now > lastEnd) {
      ongoingBreakSeconds = Math.floor((now - lastEnd) / 1000);
      if (ongoingBreakSeconds >= sch.minBreakSeconds) {
        breaks.push({ startedAt: lastEnd, endedAt: now, durationSeconds: ongoingBreakSeconds, isOngoing: true });
      }
    }
  }

  const sleep = resolveSleepWindowForDate(dateStr, sch);
  let countdownToSleepSeconds = null;
  if (dateStr === todayStr && sleep.enabled && now < sleep.bedAtMs) {
    countdownToSleepSeconds = Math.floor((sleep.bedAtMs - now) / 1000);
  }

  const dayHistory = planner.daysHistory[dateStr] || { totalSeconds: 0, maxFocusSeconds: 0 };
  const liveDelta = (active && active.date === dateStr) ? Math.max(0, Math.floor((now - active.startedAt) / 1000)) : 0;
  const tasksSum = filterDeletedEntities(planner.tasks, planner.deletedTasks)
    .filter(t => (t.date || todayStr) === dateStr)
    .reduce((sum, t) => sum + (t.spentSeconds || 0), 0);
  const loggedSessionSeconds = sessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const dayTotalSeconds = Math.max((dayHistory.totalSeconds || 0) + liveDelta, tasksSum + liveDelta, loggedSessionSeconds);
  const maxFocusSeconds = Math.max(dayHistory.maxFocusSeconds || 0, sessions.reduce((mx, s) => Math.max(mx, s.durationSeconds || 0), 0));
  const totalBreakSeconds = breaks.reduce((sum, b) => sum + b.durationSeconds, 0);

  // Compute D-Day relative to dateStr using examDate YYYY-MM-DD
  let dDay = null;
  if (appSettings.examDate) {
    const examDatePart = String(appSettings.examDate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(examDatePart)) {
      const diff = Math.round((vnDateTimeToMs(examDatePart, 0, 0) - vnDateTimeToMs(dateStr, 0, 0)) / DAY_MS);
      dDay = {
        examDate: appSettings.examDate,
        examTitle: appSettings.examTitle || 'SAT',
        daysRemaining: diff,
        label: diff > 0 ? `D-${diff}` : (diff === 0 ? 'D-DAY' : `D+${Math.abs(diff)}`)
      };
    }
  }

  const events = filterDeletedEntities(planner.calendarEvents, planner.deletedCalendarEvents).filter(ev => ev.date === dateStr);
  const dayGoals = filterDeletedEntities(planner.goals, planner.deletedGoals).filter(g => g.type === 'day' && g.scopeKey === dateStr);

  return {
    date: dateStr,
    isToday: dateStr === todayStr,
    schedule: sch,
    sessions,
    breaks,
    ongoingBreakSeconds,
    sleep,
    countdownToSleepSeconds,
    dDay,
    events,
    dayGoals,
    totals: {
      dayTotalSeconds,
      maxFocusSeconds,
      loggedSessionSeconds,
      unloggedLegacySeconds: Math.max(0, dayTotalSeconds - loggedSessionSeconds),
      totalBreakSeconds
    }
  };
}

// ========== SSE (Server-Sent Events) Real-Time Push ==========
const sseClients = new Set();

function broadcastPlannerUpdate() {
  if (sseClients.size === 0) return;
  const payload = {
    type: 'PLANNER_UPDATE',
    dailyPlanner: buildPlannerPayload(appSettings.dailyPlanner),
    habits: appSettings.habits,
    serverTime: getCanonicalNow()
  };
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

function mergeCollectionWithTombstones({ localList, localDeleted, incomingList, incomingDeleted, applyFields, pruneMs = 14 * 24 * 3600 * 1000 }) {
  let changed = false;
  const now = getCanonicalNow();
  const list = Array.isArray(localList) ? localList : [];
  const deleted = (localDeleted && typeof localDeleted === 'object') ? localDeleted : {};

  for (const [delId, delTime] of Object.entries(incomingDeleted || {})) {
    if ((deleted[delId] || 0) < delTime) {
      deleted[delId] = delTime;
      changed = true;
    }
  }
  for (const [delId, delTime] of Object.entries(deleted)) {
    if (now - delTime > pruneMs) delete deleted[delId];
  }

  const prevLen = list.length;
  const filteredList = filterDeletedEntities(list, deleted);
  if (filteredList.length !== prevLen) changed = true;

  const byId = new Map(filteredList.map(item => [String(item.id), item]));
  for (const inc of (Array.isArray(incomingList) ? incomingList : [])) {
    if (!inc || !inc.id) continue;
    const idKey = String(inc.id);
    const delTime = deleted[idKey];
    const incUpdated = inc.updatedAt || (inc.createdAt ? new Date(inc.createdAt).getTime() : 0);
    if (delTime && delTime >= incUpdated) continue;

    const existing = byId.get(idKey);
    if (!existing) {
      const cloned = { ...inc, updatedAt: incUpdated || now };
      filteredList.push(cloned);
      byId.set(idKey, cloned);
      changed = true;
    } else {
      const existingUpdated = existing.updatedAt || (existing.createdAt ? new Date(existing.createdAt).getTime() : 0);
      if (applyFields(existing, inc, existingUpdated, incUpdated)) {
        changed = true;
      }
    }
  }

  return { list: filteredList, deleted, changed };
}

// Top-Level Helper: Conflict-Free Last-Write-Wins (LWW) Task, Session, Event & History Merge
function mergePlannerTasks(localPlanner, incomingPlanner) {
  if (!incomingPlanner) return false;
  ensureDailyPlannerShape(localPlanner);
  let changed = false;

  // 1. Merge tasks with tombstones + adjustedAt safety
  const mergedTasks = mergeCollectionWithTombstones({
    localList: localPlanner.tasks,
    localDeleted: localPlanner.deletedTasks,
    incomingList: incomingPlanner.tasks,
    incomingDeleted: incomingPlanner.deletedTasks,
    pruneMs: 7 * 24 * 3600 * 1000,
    applyFields: (existing, inc, existingUpdated, incUpdated) => {
      let itemChanged = false;
      if (incUpdated > existingUpdated) {
        if (inc.title !== undefined) existing.title = inc.title;
        if (inc.section !== undefined) existing.section = inc.section;
        if (inc.date !== undefined) existing.date = inc.date;
        if (inc.deadline !== undefined) existing.deadline = inc.deadline;
        if (inc.subject !== undefined) existing.subject = inc.subject;
        if (inc.color !== undefined) existing.color = inc.color;
        existing.status = inc.status || (inc.completed ? 'completed' : 'incomplete');
        existing.completed = (existing.status === 'completed');
        existing.completedAt = inc.completedAt || null;
        existing.updatedAt = incUpdated;
        itemChanged = true;
      }
      const incAdj = inc.adjustedAt || 0;
      const existAdj = existing.adjustedAt || 0;
      if (incAdj > existAdj) {
        existing.spentSeconds = Math.max(0, inc.spentSeconds || 0);
        existing.adjustedAt = incAdj;
        itemChanged = true;
      } else if (incAdj === existAdj && (inc.spentSeconds || 0) > (existing.spentSeconds || 0)) {
        existing.spentSeconds = inc.spentSeconds;
        itemChanged = true;
      }
      return itemChanged;
    }
  });
  localPlanner.tasks = mergedTasks.list;
  localPlanner.deletedTasks = mergedTasks.deleted;
  if (mergedTasks.changed) changed = true;

  // 2. Merge goals with tombstones
  const mergedGoals = mergeCollectionWithTombstones({
    localList: localPlanner.goals,
    localDeleted: localPlanner.deletedGoals,
    incomingList: incomingPlanner.goals,
    incomingDeleted: incomingPlanner.deletedGoals,
    pruneMs: 7 * 24 * 3600 * 1000,
    applyFields: (existing, inc, existingUpdated, incUpdated) => {
      if (incUpdated <= existingUpdated) return false;
      if (inc.text !== undefined) existing.text = inc.text;
      if (inc.priority !== undefined) existing.priority = inc.priority;
      if (inc.type !== undefined) existing.type = inc.type;
      if (inc.scopeKey !== undefined) existing.scopeKey = inc.scopeKey;
      if (inc.completed !== undefined) existing.completed = inc.completed;
      existing.updatedAt = incUpdated;
      return true;
    }
  });
  localPlanner.goals = mergedGoals.list;
  localPlanner.deletedGoals = mergedGoals.deleted;
  if (mergedGoals.changed) changed = true;

  // 3. Merge study sessions with tombstones
  const mergedSessions = mergeCollectionWithTombstones({
    localList: localPlanner.sessions,
    localDeleted: localPlanner.deletedSessions,
    incomingList: incomingPlanner.sessions,
    incomingDeleted: incomingPlanner.deletedSessions,
    applyFields: (existing, inc, existingUpdated, incUpdated) => {
      if (incUpdated > existingUpdated) {
        Object.assign(existing, {
          ...inc,
          startedAt: Number(inc.startedAt) || existing.startedAt,
          endedAt: Number(inc.endedAt) || existing.endedAt,
          durationSeconds: Number.isFinite(Number(inc.durationSeconds)) ? Number(inc.durationSeconds) : existing.durationSeconds,
          updatedAt: incUpdated
        });
        return true;
      }
      return false;
    }
  });
  localPlanner.sessions = mergedSessions.list;
  localPlanner.deletedSessions = mergedSessions.deleted;
  if (mergedSessions.changed) changed = true;

  // 4. Merge calendarEvents (Month milestones) with tombstones
  const mergedCalEvents = mergeCollectionWithTombstones({
    localList: localPlanner.calendarEvents,
    localDeleted: localPlanner.deletedCalendarEvents,
    incomingList: incomingPlanner.calendarEvents,
    incomingDeleted: incomingPlanner.deletedCalendarEvents,
    applyFields: (existing, inc, existingUpdated, incUpdated) => {
      if (incUpdated <= existingUpdated) return false;
      if (inc.title !== undefined) existing.title = inc.title;
      if (inc.date !== undefined) existing.date = inc.date;
      if (inc.color !== undefined) existing.color = inc.color;
      existing.updatedAt = incUpdated;
      return true;
    }
  });
  localPlanner.calendarEvents = mergedCalEvents.list;
  localPlanner.deletedCalendarEvents = mergedCalEvents.deleted;
  if (mergedCalEvents.changed) changed = true;

  // 5. Merge scheduleSettings (Sleep window & dayStartHour) via LWW
  if (incomingPlanner.scheduleSettings && typeof incomingPlanner.scheduleSettings === 'object') {
    const incSch = normalizeScheduleSettings(incomingPlanner.scheduleSettings);
    const curSch = normalizeScheduleSettings(localPlanner.scheduleSettings);
    if (incSch.updatedAt > curSch.updatedAt) {
      localPlanner.scheduleSettings = incSch;
      changed = true;
    }
  }

  // 6. Merge daysHistory (respecting adjustedAt when sessions were edited/deleted)
  const incHistory = incomingPlanner.daysHistory || {};
  for (const [dateKey, dayData] of Object.entries(incHistory)) {
    if (!dayData || typeof dayData !== 'object') continue;
    if (!localPlanner.daysHistory[dateKey]) {
      localPlanner.daysHistory[dateKey] = { ...dayData };
      changed = true;
    } else {
      const cur = localPlanner.daysHistory[dateKey];
      const incAdj = dayData.adjustedAt || 0;
      const curAdj = cur.adjustedAt || 0;
      if (incAdj > curAdj) {
        cur.totalSeconds = Math.max(0, dayData.totalSeconds || 0);
        cur.maxFocusSeconds = Math.max(0, dayData.maxFocusSeconds || 0);
        cur.adjustedAt = incAdj;
        changed = true;
      } else if (incAdj === curAdj) {
        if ((dayData.totalSeconds || 0) > (cur.totalSeconds || 0)) {
          cur.totalSeconds = dayData.totalSeconds;
          changed = true;
        }
        if ((dayData.maxFocusSeconds || 0) > (cur.maxFocusSeconds || 0)) {
          cur.maxFocusSeconds = dayData.maxFocusSeconds;
          changed = true;
        }
      }
    }
  }

  // 7. Merge lastTimerStoppedAt (Newest stop wins cleanly)
  if ((incomingPlanner.lastTimerStoppedAt || 0) > (localPlanner.lastTimerStoppedAt || 0)) {
    localPlanner.lastTimerStoppedAt = incomingPlanner.lastTimerStoppedAt;
    changed = true;
  }

  return changed;
}

// Top-Level Helper: Conflict-Free Habits Merge (LWW + Tombstones + Date-Union History)
function mergeHabits(localHabits, incomingHabits) {
  if (!incomingHabits || typeof incomingHabits !== 'object') return false;
  if (!localHabits || typeof localHabits !== 'object') return false;

  let changed = false;
  if (!localHabits.list) localHabits.list = [];
  if (!localHabits.history) localHabits.history = {};
  if (!localHabits.deletedHabits) localHabits.deletedHabits = {};

  // 1. Merge deletedHabits tombstones (newest timestamp wins)
  const incDeleted = incomingHabits.deletedHabits || {};
  for (const [delId, delTime] of Object.entries(incDeleted)) {
    if ((localHabits.deletedHabits[delId] || 0) < delTime) {
      localHabits.deletedHabits[delId] = delTime;
      changed = true;
    }
  }

  // Prune tombstones older than 14 days
  const FOURTEEN_DAYS = 14 * 24 * 3600 * 1000;
  const now = Date.now();
  for (const [delId, delTime] of Object.entries(localHabits.deletedHabits)) {
    if (now - delTime > FOURTEEN_DAYS) {
      delete localHabits.deletedHabits[delId];
    }
  }

  // 2. Remove locally active habits that were deleted remotely
  const prevCount = localHabits.list.length;
  localHabits.list = localHabits.list.filter(h => !localHabits.deletedHabits[h.id]);
  if (localHabits.list.length !== prevCount) changed = true;

  // Purge deleted habits from local history
  for (const d of Object.keys(localHabits.history)) {
    const beforeLen = (localHabits.history[d] || []).length;
    localHabits.history[d] = (localHabits.history[d] || []).filter(id => !localHabits.deletedHabits[id]);
    if (localHabits.history[d].length !== beforeLen) changed = true;
  }

  // 3. Merge incoming habit list
  const incChangedAt = incomingHabits.changedAt || 0;
  const localChangedAt = localHabits.changedAt || 0;
  const incomingList = Array.isArray(incomingHabits.list) ? incomingHabits.list : [];

  if (incChangedAt > localChangedAt) {
    // Incoming is newer: adopt incoming list (filtering out any deleted ones)
    const validIncoming = incomingList.filter(h => h && h.id && !localHabits.deletedHabits[h.id]);
    if (JSON.stringify(validIncoming) !== JSON.stringify(localHabits.list)) {
      localHabits.list = validIncoming;
      changed = true;
    }
    localHabits.changedAt = incChangedAt;
  } else {
    // Local is newer or equal: add any brand-new habits from incoming that aren't deleted
    for (const incH of incomingList) {
      if (!incH || !incH.id || localHabits.deletedHabits[incH.id]) continue;
      if (!localHabits.list.some(h => h.id === incH.id)) {
        localHabits.list.push({ ...incH });
        changed = true;
      }
    }
  }

  // 4. Merge history intelligently per-date (Date-Union Merge, never overwrite and lose checked days)
  const incHistory = incomingHabits.history || {};
  for (const [d, arr] of Object.entries(incHistory)) {
    if (!Array.isArray(arr)) continue;
    const localArr = localHabits.history[d] || [];
    const filteredIncoming = arr.filter(id => !localHabits.deletedHabits[id]);
    const merged = Array.from(new Set([...localArr, ...filteredIncoming]));
    if (merged.length !== localArr.length) {
      localHabits.history[d] = merged;
      changed = true;
    }
  }

  return changed;
}

// Subject detection logic
function detectSubject(title = '', altText = '') {
  const t = (title + ' ' + altText).toLowerCase();

  const mathKeywords = [
    'math', 'algebra', 'geometry', 'statistic', 'toán', 'function', 'equation',
    'triangle', 'circle', 'polynomial', 'graph', 'm-ad', 'sat m-', 'calculus',
    'probability', 'arithmetic', 'coordinate', 'parabola', 'linear',
    'area', 'volume', 'ratio', 'percentage', 'percent', 'angle', 'line', 'rates',
    'quadratic', 'integer', 'exponent', 'quadrilateral', 'polygon', 'inequality', 'system',
    'data analysis', 'data anaysis', 'analysis', 'data'
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
  if (noMatch) {
    res.no = noMatch[1];
  } else {
    // Check for parenthesized number e.g. (2) or (No. 2) or trailing number like - 2
    const parenMatch = str.match(/\(\s*(?:no\.?)?\s*(\d+)\s*\)/i) || str.match(/[\s\-_](\d+)\s*(?:\.pdf)?$/i);
    if (parenMatch) res.no = parenMatch[1];
  }

  const setMatch = norm.match(/set\s*(\d+|[a-z])\b/);
  if (setMatch) res.set = setMatch[1];

  const wordsInContextMatch = norm.match(/words\s*in\s*context\s*(\d+)/);
  if (wordsInContextMatch) res.wic = wordsInContextMatch[1];

  const buoiMatch = str.toLowerCase().match(/bu[ổo]i\s*(\d+)/i);
  if (buoiMatch) res.buoi = buoiMatch[1];

  return res;
}

// Helper: Match PDF title with known To-do items
function matchTodo(title = '', filename = '', excludeIds = null) {
  // Direct Ground-Truth Match: Check if title or filename contains activityId=XXXXX
  const actMatch = (title + ' ' + filename).match(/activityId=(\d+)/i);
  if (actMatch) {
    const actId = actMatch[1];
    const directTodo = Array.from(todoStore.values()).find(t => String(t.activityId) === String(actId));
    if (directTodo) return directTodo;
  }

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
    if (fileNumbers.buoi && todoNumbers.buoi && fileNumbers.buoi !== todoNumbers.buoi) continue;

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
  // If running in cloud container (Render), disk is ephemeral and local directories do not exist.
  // Never delete items from pdfStore on cloud! Keep all captured metadata and CDN URLs.
  if (IS_CLOUD_INSTANCE) return;

  // Clean up any items whose files were moved or deleted from disk ONLY if they don't have a CDN URL
  for (const [key, item] of pdfStore.entries()) {
    if (item.localPath && !fs.existsSync(item.localPath)) {
      if (!item.url) {
        pdfStore.delete(key);
      } else {
        item.downloaded = false;
      }
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
      } catch (e) { }
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

        let targetActivityId = null;
        try {
          const parsed = new URL(target.url);
          targetActivityId = parsed.searchParams.get('activityId') || parsed.searchParams.get('activity_id');
        } catch (e) {
          const match = target.url.match(/activityId=(\d+)/i);
          if (match) targetActivityId = match[1];
        }

        const uniquePdfUrls = Array.from(new Set(perfRes?.result?.value || []));
        const domNames = domRes?.result?.value || [];
        const defaultName = domNames.find(n => n.endsWith('.pdf')) || domNames[0] || 'ClassIn_Homework.pdf';

        for (const pdfUrl of uniquePdfUrls) {
          let cleanName = defaultName;
          if (!cleanName.toLowerCase().endsWith('.pdf')) cleanName += '.pdf';
          cleanName = cleanName.replace(/[<>:"/\\|?*]/g, '_').trim();

          const uniqueId = crypto.createHash('md5').update(pdfUrl).digest('hex');

          // Match Todo with absolute priority:
          // 1. Direct activityId match from target URL (100% ground-truth)
          let todo = null;
          if (targetActivityId) {
            todo = Array.from(todoStore.values()).find(t => String(t.activityId) === String(targetActivityId));
          }
          // 2. Exact/fuzzy match with DOM text names
          if (!todo) {
            for (const dName of domNames) {
              todo = matchTodo(dName, target.title);
              if (todo) break;
            }
          }
          // 3. Match with cleanName & target.title
          if (!todo) {
            todo = matchTodo(cleanName, target.title);
          }

          const detectedSubject = todo ? detectSubject(todo.title) : detectSubject(cleanName, target.title);
          const deadlineTag = getDeadlineTag(todo) || (detectedSubject === 'MATH' ? '[21.10]' : '[17.10]');
          const canonicalTitle = todo ? todo.title : (domNames.find(n => !n.endsWith('.pdf')) || domNames[0] || cleanName);

          // Find existing item STRICTLY:
          // 1. By exact uniqueId or pdfUrl
          // 2. OR by cleanBaseName
          // 3. OR by exact todoId
          let existingItem = pdfStore.get(pdfUrl) || Array.from(pdfStore.values()).find(i =>
            i.id === uniqueId ||
            i.url === pdfUrl ||
            (i.filename && cleanBaseName(i.filename).toLowerCase() === cleanBaseName(cleanName).toLowerCase()) ||
            (todo && i.todoId === todo.id)
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
              console.log(`[ClassIn CDP] Đang tự động tải bài tập: ${cleanName} -> ${formattedName}`);
              await fetchFile(pdfUrl, destPath);
              downloaded = true;
              finalPath = destPath;
            } catch (dlErr) {
              console.error(`[ClassIn CDP] Lỗi tải file ${cleanName}:`, dlErr.message);
            }
          }

          if (!existingItem) {
            pdfStore.set(pdfUrl, {
              id: uniqueId,
              filename: formattedName,
              title: canonicalTitle,
              url: pdfUrl,
              pageUrl: target.url,
              todoId: todo ? todo.id : null,
              activityId: todo ? todo.activityId : (targetActivityId ? Number(targetActivityId) : null),
              courseId: todo ? todo.courseId : null,
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
            matchAllTodos();
            saveDatabase();
            console.log(`[+] Đã nhận diện bài tập ClassIn: ${cleanBaseName(cleanName)} [${subj}] ${deadlineTag}`);
          } else {
            let changed = false;
            if (!existingItem.url) { existingItem.url = pdfUrl; changed = true; }
            if (todo && !existingItem.todoId) { existingItem.todoId = todo.id; existingItem.title = todo.title; changed = true; }
            if (downloaded && (!existingItem.localPath || !fs.existsSync(existingItem.localPath))) {
              existingItem.localPath = finalPath;
              existingItem.downloaded = true;
              existingItem.filename = formattedName;
              changed = true;
            }
            if (changed) {
              matchAllTodos();
              saveDatabase();
              console.log(`[+] Cập nhật bài tập ClassIn: ${cleanBaseName(cleanName)} [${subj}] ${deadlineTag}`);
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
        // Also mirror to user's Downloads/10SAT folder if running locally on Windows
        try {
          if (!IS_CLOUD_INSTANCE && USER_DOWNLOADS_10SAT && destPath) {
            const fileName = path.basename(destPath);
            const parentDir = path.basename(path.dirname(destPath)); // 'MATH' or 'VERBAL'
            if (['MATH', 'VERBAL'].includes(parentDir)) {
              const targetDir = path.join(USER_DOWNLOADS_10SAT, parentDir);
              fs.mkdirSync(targetDir, { recursive: true });
              const mirrorPath = path.join(targetDir, fileName);
              if (path.resolve(destPath) !== path.resolve(mirrorPath)) {
                fs.copyFileSync(destPath, mirrorPath);
              }
            }
          }
        } catch (_) { }
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
    try {
      const existing = resolveLocalPdfPath(item);
      if (existing && fs.existsSync(existing)) {
        item.localPath = existing;
        item.downloaded = true;
        continue;
      }
      if (item.url && item.url.startsWith('http')) {
        const subj = (item.subject || detectSubject(item.filename || item.title) || 'VERBAL').toUpperCase();
        const destDir = subj === 'MATH' ? MATH_DIR : VERBAL_DIR;
        const formattedName = formatFilename(item.filename || item.title, item.deadlineTag, subj);
        if (!destDir || !formattedName) continue;
        const destPath = path.join(destDir, formattedName);
        await fetchFile(item.url, destPath);
        item.localPath = destPath;
        item.downloaded = true;
        item.filename = formattedName;
        saveDatabase();
        console.log(`[+]  ${cleanBaseName(formattedName)} [${subj}] ${item.deadlineTag || ''}`);
      }
    } catch (err) {
      // Non-blocking safe catch
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
      const fileOnDisk = !!resolveLocalPdfPath(pdf);
      merged.push({
        ...pdf,
        title: bestTodo.title,
        todoId: bestTodo.id,
        activityId: bestTodo.activityId,
        courseId: bestTodo.courseId,
        timeLimit: bestTodo.timeLimit || (timed ? 80 : 0),
        hasFile: !!(fileOnDisk || pdf.url || (IS_CLOUD_INSTANCE && pdf.downloaded)),
        downloaded: !!(fileOnDisk || (IS_CLOUD_INSTANCE && pdf.downloaded)),
        hasCloudUrl: !!(pdf.url && pdf.url.startsWith('http')),
        url: pdf.url || '',
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
      const fileOnDisk = !!resolveLocalPdfPath(pdf);
      merged.push({
        ...pdf,
        hasFile: !!(fileOnDisk || pdf.url || (IS_CLOUD_INSTANCE && pdf.downloaded)),
        downloaded: !!(fileOnDisk || (IS_CLOUD_INSTANCE && pdf.downloaded)),
        hasCloudUrl: !!(pdf.url && pdf.url.startsWith('http')),
        url: pdf.url || '',
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
  const today = getVnDateStr();
  const dayStats = appSettings.dailyPlanner?.daysHistory?.[today];
  let total = dayStats?.totalSeconds || 0;
  const active = appSettings.dailyPlanner?.activeTimer;
  if (active && active.startedAt && (!active.date || active.date === today)) {
    total += Math.max(0, Math.floor((getCanonicalNow() - active.startedAt) / 1000));
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
    } catch (e) { }
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
    } catch (e) { }
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
    try { discordIpcClient.destroy(); } catch (e) { }
    discordIpcClient = null;
  }
  discordIpcConnected = false;
  discordUserInfo = null;
}

let lastDiscordActivitySent = 0;
let pendingDiscordTimer = null;
let queuedDiscordActivity = null;
const DISCORD_MIN_INTERVAL = 3000; // 3-second safety gap to prevent hitting Discord's 5 reqs/20s rate limit
let discordStudyAnchor = null; // { taskId, startSec, mode }

function updateDiscordActivity(activity, immediate = false) {
  if (!discordIpcClient || !discordIpcConnected) return;

  const now = Date.now();
  const timeSinceLast = now - lastDiscordActivitySent;

  if (timeSinceLast >= DISCORD_MIN_INTERVAL || (immediate && timeSinceLast >= 1500)) {
    if (pendingDiscordTimer) {
      clearTimeout(pendingDiscordTimer);
      pendingDiscordTimer = null;
    }
    queuedDiscordActivity = null;
    sendDiscordActivityNow(activity);
  } else {
    // Queue latest activity to send as soon as cooldown finishes
    queuedDiscordActivity = activity;
    if (!pendingDiscordTimer) {
      const waitTime = Math.max(200, DISCORD_MIN_INTERVAL - timeSinceLast);
      pendingDiscordTimer = setTimeout(() => {
        pendingDiscordTimer = null;
        if (queuedDiscordActivity) {
          const act = queuedDiscordActivity;
          queuedDiscordActivity = null;
          sendDiscordActivityNow(act);
        }
      }, waitTime);
    }
  }
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
    discordStudyAnchor = null;
    discordRestStartedAt = null;
    updateDiscordActivity(null, immediate);
    return;
  }

  const today = getVnDateStr();
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

    // Live elapsed time using canonical now:
    const canonicalNow = getCanonicalNow();
    const liveSessionSec = Math.max(0, Math.floor((canonicalNow - active.startedAt) / 1000));
    const taskCumulativeSec = (taskObj?.spentSeconds || 0) + liveSessionSec;

    // State line:
    let stateText = undefined;
    const stateFmt = appSettings.discordRpc?.stateFormat || 'today_stats';
    if (stateFmt === 'today_stats') {
      if (appSettings.discordRpc?.mode === 'task') {
        stateText = `Total today: ${formatTotalStudy(todayTotalSec + liveSessionSec)}`;
      } else {
        stateText = `Task: ${formatTotalStudy(taskCumulativeSec)}`;
      }
    } else if (stateFmt === 'custom') {
      stateText = appSettings.discordRpc?.customState || undefined;
    }

    // Stable anchor in local Windows time:
    // Discord runs locally on Windows and compares timestamps.start against local Date.now()!
    const mode = appSettings.discordRpc?.mode || 'cumulative';
    let startSec;
    if (discordStudyAnchor && discordStudyAnchor.taskId === active.taskId && discordStudyAnchor.mode === mode) {
      // Reuse stable anchor: DO NOT change startSec during an active session!
      // This allows Discord's client engine to tick 1s-by-1s smoothly with zero jitter or freezes!
      startSec = discordStudyAnchor.startSec;
    } else {
      const localNowSec = Math.floor(Date.now() / 1000);
      if (mode === 'task') {
        startSec = localNowSec - taskCumulativeSec;
      } else {
        startSec = localNowSec - (todayTotalSec + liveSessionSec);
      }
      discordStudyAnchor = { taskId: active.taskId, startSec, mode };
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
    discordStudyAnchor = null;
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

// Background periodic sync: Refresh Discord presence every 30s to keep stats fresh without tripping rate limits
setInterval(() => {
  if (discordIpcConnected && appSettings.discordRpc?.enabled && appSettings.dailyPlanner?.activeTimer) {
    syncDiscordPresenceFromActiveTimer(false);
  }
}, 30000);

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // 0. SSE: Real-Time Push Endpoint
  if (parsedUrl.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Send initial state immediately so client is in sync from the start
    const initPayload = {
      type: 'PLANNER_UPDATE',
      dailyPlanner: buildPlannerPayload(appSettings.dailyPlanner),
      habits: appSettings.habits,
      serverTime: getCanonicalNow()
    };
    res.write(`data: ${JSON.stringify(initPayload)}\n\n`);
    sseClients.add(res);
    // Send heartbeat every 30s to keep connection alive through proxies
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (e) { } }, 30000);
    req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
    return;
  }

  // 1. API: List detected PDFs & stats & settings
  if (parsedUrl.pathname === '/api/list') {
    let connected = false;
    try {
      const check = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) });
      connected = check.ok;
    } catch { }

    const items = getMergedItems();
    const mathFilesOnDisk = fs.existsSync(MATH_DIR) ? fs.readdirSync(MATH_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).length : 0;
    const verbalFilesOnDisk = fs.existsSync(VERBAL_DIR) ? fs.readdirSync(VERBAL_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).length : 0;

    const stats = {
      total: items.length,
      hasFile: items.filter(i => i.hasFile).length,
      hasCloudUrl: items.filter(i => i.hasCloudUrl).length,
      pendingFile: items.filter(i => !i.hasFile && !i.hasCloudUrl).length,
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
      pendingSafeHomeworks: items.filter(i => !i.hasFile && !i.isTimed && !i.noPdf).length,
      isCloud: IS_CLOUD_INSTANCE
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      connected,
      isCloud: IS_CLOUD_INSTANCE,
      baseDir: BASE_10SAT,
      verbalDir: VERBAL_DIR,
      mathDir: MATH_DIR,
      stats,
      settings: {
        ...appSettings,
        dailyPlanner: buildPlannerPayload(appSettings.dailyPlanner)
      },
      items,
      serverTime: getCanonicalNow()
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
      } catch { }

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

  // Helper: Stream Remote PDF with redirect following & content-disposition
  function streamRemotePdf(targetUrl, res, asAttachment = false, filename = 'document.pdf', maxRedirects = 3) {
    if (maxRedirects <= 0) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Quá nhiều chuyển hướng khi tải file PDF.');
    }

    const client = targetUrl.startsWith('https') ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://b1s-cdn.eeo.cn/'
      }
    }, (proxyRes) => {
      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 307 || proxyRes.statusCode === 308) {
        const redirectLocation = proxyRes.headers.location;
        if (redirectLocation) {
          return streamRemotePdf(redirectLocation, res, asAttachment, filename, maxRedirects - 1);
        }
      }

      if (proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`Lỗi tải từ máy chủ nguồn (Mã: ${proxyRes.statusCode})`);
      }

      const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_');
      const dispositionType = asAttachment ? 'attachment' : 'inline';
      const contentDisposition = `${dispositionType}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition,
        ...(proxyRes.headers['content-length'] ? { 'Content-Length': proxyRes.headers['content-length'] } : {})
      });

      proxyRes.pipe(res);
    });

    req.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Lỗi kết nối tải PDF: ${err.message}`);
      }
    });
  }

  // 4. API: Stream PDF for in-app Preview
  if (parsedUrl.pathname === '/api/preview') {
    const id = parsedUrl.searchParams.get('id');
    const directUrl = parsedUrl.searchParams.get('url');
    const allItems = getMergedItems();
    const item = (id ? allItems.find(p => p.id === id) : null) ||
      (id ? Array.from(pdfStore.values()).find(p => p.id === id) : null) ||
      (directUrl ? Array.from(pdfStore.values()).find(p => p.url === directUrl) : null);

    const targetUrl = item?.url || directUrl;
    const rawName = (item?.title || item?.filename || 'tai_lieu_sat').replace(/\.pdf$/i, '').trim();
    const cleanFilename = rawName.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

    const localFilePath = resolveLocalPdfPath(item);
    if (localFilePath && fs.existsSync(localFilePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(cleanFilename)}"`,
        'Content-Length': fs.statSync(localFilePath).size
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }

    if (targetUrl) {
      return streamRemotePdf(targetUrl, res, false, cleanFilename);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không tìm thấy file để xem trước.');
  }

  // 4b. API: Direct PDF Download (works seamlessly on Mobile & Cloud)
  if (parsedUrl.pathname === '/api/download-pdf') {
    const id = parsedUrl.searchParams.get('id');
    const directUrl = parsedUrl.searchParams.get('url');
    const queryFilename = parsedUrl.searchParams.get('filename');
    const allItems = getMergedItems();
    const item = (id ? allItems.find(p => p.id === id) : null) ||
      (id ? Array.from(pdfStore.values()).find(p => p.id === id) : null) ||
      (directUrl ? Array.from(pdfStore.values()).find(p => p.url === directUrl) : null);

    const targetUrl = item?.url || directUrl;
    const rawName = (queryFilename || item?.title || item?.filename || 'tai_lieu_sat').replace(/\.pdf$/i, '').trim();
    const cleanFilename = rawName.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

    const localFilePath = resolveLocalPdfPath(item);
    if (localFilePath && fs.existsSync(localFilePath)) {
      const safeAscii = cleanFilename.replace(/[^\x20-\x7E]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`,
        'Content-Length': fs.statSync(localFilePath).size
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }

    if (targetUrl) {
      return streamRemotePdf(targetUrl, res, true, cleanFilename);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không tìm thấy file để tải về.');
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
      } catch (err) { }
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
            try { tempWs.close(); } catch (e) { }
          }
        }
      } catch (e) { }
    }

    // 2. Verify sub-window closed cleanly (NO /json/close!)
    for (let attempt = 1; attempt <= 8; attempt++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(600) })).json();
        if (!t.some(x => x.id === subTargetId)) {
          return true; // Target confirmed closed!
        }
      } catch (e) { }
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
    } catch { }

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
        } catch { }
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
        try { wsAns.close(); } catch (e) { }
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
        try { wsAns.close(); } catch (e) { }
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
      try { wsAns.close(); } catch (e) { }
    } catch (winErr) {
      try { await closeClassInSubWindow(wsAns, answersheetTarget?.id); wsAns.close(); } catch { }
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

  // 9.8 API: 24/7 Keep-Alive & Health Ping (Prevents Render Free Tier sleep)
  if (parsedUrl.pathname === '/api/ping' || parsedUrl.pathname === '/ping' || parsedUrl.pathname === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store'
    });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'elias-study-planner',
      isCloud: IS_CLOUD_INSTANCE,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: Date.now()
    }));
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
        history: {},
        deletedHabits: {},
        changedAt: 0
      };
    }
    if (!appSettings.habits.deletedHabits) appSettings.habits.deletedHabits = {};

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { action, id, title, category, date } = parsed;

          if (action === 'toggle') {
            const d = date || getVnDateStr();
            if (!appSettings.habits.history) appSettings.habits.history = {};
            if (!Array.isArray(appSettings.habits.history[d])) appSettings.habits.history[d] = [];

            const habitId = String(id);
            const idx = appSettings.habits.history[d].indexOf(habitId);
            if (idx >= 0) {
              appSettings.habits.history[d].splice(idx, 1);
            } else {
              appSettings.habits.history[d].push(habitId);
            }
          } else if (action === 'add' && title && title.trim()) {
            const newId = 'h_' + Date.now();
            if (appSettings.habits.deletedHabits && appSettings.habits.deletedHabits[newId]) {
              delete appSettings.habits.deletedHabits[newId];
            }
            const newHabit = {
              id: newId,
              title: title.trim(),
              category: (category || 'Chung').trim()
            };
            if (!Array.isArray(appSettings.habits.list)) appSettings.habits.list = [];
            appSettings.habits.list.push(newHabit);
          } else if (action === 'edit' && id) {
            const habitId = String(id);
            const h = (appSettings.habits.list || []).find(item => String(item.id) === habitId);
            if (h) {
              if (title) h.title = title.trim();
              if (category) h.category = category.trim();
            }
          } else if (action === 'delete' && id) {
            const habitId = String(id);
            if (!appSettings.habits.deletedHabits) appSettings.habits.deletedHabits = {};
            appSettings.habits.deletedHabits[habitId] = Date.now();
            appSettings.habits.list = (appSettings.habits.list || []).filter(item => String(item.id) !== habitId);
            for (const d of Object.keys(appSettings.habits.history || {})) {
              appSettings.habits.history[d] = (appSettings.habits.history[d] || []).filter(item => String(item) !== habitId);
            }
          } else if (action === 'reorder' && Array.isArray(parsed.orderedIds)) {
            const idMap = new Map((appSettings.habits.list || []).map(h => [String(h.id), h]));
            const newList = [];
            for (const oId of parsed.orderedIds) {
              const item = idMap.get(String(oId));
              if (item) {
                newList.push(item);
                idMap.delete(String(oId));
              }
            }
            for (const remaining of idMap.values()) {
              newList.push(remaining);
            }
            appSettings.habits.list = newList;
          }

          appSettings.habits.changedAt = Date.now();
          saveDatabase();
          broadcastPlannerUpdate();
          if (typeof triggerCloudSync === 'function') triggerCloudSync();
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
    if (!appSettings.dailyPlanner) appSettings.dailyPlanner = {};
    ensureDailyPlannerShape(appSettings.dailyPlanner);

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const { action, id, title, section, date, deadline, status } = parsed;
          const now = getCanonicalNow();
          const planner = appSettings.dailyPlanner;

          if (action === 'add' && title && title.trim()) {
            const meta = inferPlannerSubjectAndColor(title.trim(), parsed.subject, parsed.color);
            const newTask = {
              id: parsed.id || ('dp_' + now + '_' + Math.random().toString(36).slice(2, 6)),
              title: title.trim(),
              section: section || 'morning',
              date: date || getVnDateStr(),
              deadline: deadline || '',
              subject: meta.subject,
              color: meta.color,
              completed: false,
              status: 'incomplete',
              spentSeconds: 0,
              createdAt: new Date().toISOString(),
              updatedAt: now
            };
            planner.tasks.push(newTask);
          } else if (action === 'set-status' && id) {
            const t = planner.tasks.find(item => item.id === id);
            if (t) {
              t.status = status || 'incomplete';
              t.completed = (t.status === 'completed');
              t.updatedAt = now;
              if (t.completed) {
                t.completedAt = new Date().toISOString();
                if (planner.activeTimer?.taskId === id) {
                  applyActiveTimerDelta(planner, now, 'stop');
                }
              } else {
                t.completedAt = null;
              }
            }
          } else if (action === 'start-timer' && id) {
            const t = planner.tasks.find(item => item.id === id);
            if (t) {
              const taskDate = date || t.date || getVnDateStr();
              if (planner.activeTimer) {
                applyActiveTimerDelta(planner, now, 'stop');
              }

              const clientStartedAtNum = Number(parsed.clientStartedAt);
              const useClientTime = !isNaN(clientStartedAtNum) && Math.abs(clientStartedAtNum - now) < 60000;
              const startedAtTime = useClientTime ? clientStartedAtNum : now;
              const meta = inferPlannerSubjectAndColor(t.title, t.subject, t.color);
              const sesId = (parsed.sessionId && /^ses_[a-zA-Z0-9_]+$/.test(String(parsed.sessionId)))
                ? String(parsed.sessionId)
                : ('ses_' + startedAtTime + '_' + Math.random().toString(36).slice(2, 6));

              planner.activeTimer = {
                taskId: t.id,
                taskTitle: t.title,
                subject: meta.subject,
                color: meta.color,
                sessionId: sesId,
                startedAt: startedAtTime,
                sessionStartedAt: startedAtTime,
                date: taskDate
              };
              planner.activeTimerChangedAt = now;
            }
          } else if (action === 'stop-timer') {
            if (planner.activeTimer) {
              applyActiveTimerDelta(planner, now, 'stop');
            }
          } else if (action === 'checkpoint-timer') {
            if (planner.activeTimer) {
              applyActiveTimerDelta(planner, now, 'checkpoint');
            }
          } else if (action === 'toggle' && id) {
            const t = planner.tasks.find(item => item.id === id);
            if (t) {
              t.completed = !t.completed;
              t.status = t.completed ? 'completed' : 'incomplete';
              t.updatedAt = now;
              if (t.completed) {
                t.completedAt = new Date().toISOString();
                if (planner.activeTimer?.taskId === id) {
                  applyActiveTimerDelta(planner, now, 'stop');
                }
              } else {
                t.completedAt = null;
              }
            }
          } else if (action === 'edit' && id) {
            const t = planner.tasks.find(item => item.id === id);
            if (t) {
              if (title !== undefined) t.title = title.trim();
              if (section !== undefined) t.section = section;
              if (deadline !== undefined) t.deadline = deadline;
              if (date !== undefined) t.date = date;
              if (parsed.subject !== undefined || parsed.color !== undefined || title !== undefined) {
                const meta = inferPlannerSubjectAndColor(
                  t.title,
                  parsed.subject !== undefined ? parsed.subject : (title !== undefined ? '' : t.subject),
                  parsed.color !== undefined ? parsed.color : t.color
                );
                t.subject = meta.subject;
                if (parsed.color !== undefined || !t.color) t.color = meta.color;
              }
              if (status !== undefined) {
                t.status = status;
                t.completed = (status === 'completed');
              }
              t.updatedAt = now;
              if (planner.activeTimer?.taskId === id && title !== undefined) {
                planner.activeTimer.taskTitle = t.title;
                if (t.subject) planner.activeTimer.subject = t.subject;
                if (t.color) planner.activeTimer.color = t.color;
                planner.activeTimerChangedAt = now;
              }
            }
          } else if (action === 'delete' && id) {
            if (planner.activeTimer?.taskId === id) {
              applyActiveTimerDelta(planner, now, 'stop');
            }
            planner.deletedTasks[id] = now;
            planner.tasks = planner.tasks.filter(item => item.id !== id);
            // Preserve sessions history on timeline while unlinking deleted task
            for (const s of planner.sessions) {
              if (s.taskId === id) {
                s.taskId = null;
                s.updatedAt = now;
              }
            }
          } else if (action === 'reorder' && Array.isArray(parsed.orderedIds)) {
            const idMap = new Map((planner.tasks || []).map(t => [String(t.id), t]));
            if (parsed.movedTaskId && parsed.newSection) {
              const moved = idMap.get(String(parsed.movedTaskId));
              if (moved) {
                moved.section = parsed.newSection;
                moved.updatedAt = now;
              }
            }
            const newTasks = [];
            for (const oId of parsed.orderedIds) {
              const item = idMap.get(String(oId));
              if (item) {
                newTasks.push(item);
                idMap.delete(String(oId));
              }
            }
            for (const remaining of idMap.values()) {
              newTasks.push(remaining);
            }
            planner.tasks = newTasks;
          } else if (action === 'add-session' || action === 'update-session') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: 'Đã tắt tính năng thêm hoặc sửa giờ học thủ công để đảm bảo dữ liệu thực tế.' }));
          } else if (action === 'delete-session' && id) {
            if (planner.activeTimer?.sessionId === id) {
              applyActiveTimerDelta(planner, now, 'stop');
            }
            const s = planner.sessions.find(item => item.id === id);
            planner.deletedSessions[id] = now;
            planner.sessions = planner.sessions.filter(item => item.id !== id);
            if (s) {
              const sDate = s.date || getVnDateStr(s.startedAt);
              const oldDur = s.durationSeconds || 0;
              if (!planner.daysHistory[sDate]) planner.daysHistory[sDate] = { totalSeconds: 0, maxFocusSeconds: 0 };
              planner.daysHistory[sDate].totalSeconds = Math.max(0, (planner.daysHistory[sDate].totalSeconds || 0) - oldDur);
              planner.daysHistory[sDate].adjustedAt = now;
              recomputeDayStatsFromSessions(planner, sDate);
              if (s.taskId) {
                const t = planner.tasks.find(item => item.id === s.taskId);
                if (t) {
                  t.spentSeconds = Math.max(0, (t.spentSeconds || 0) - oldDur);
                  t.adjustedAt = now;
                  t.updatedAt = now;
                }
              }
            }
          } else if (action === 'add-cal-event' && parsed.title && String(parsed.title).trim()) {
            const evDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : getVnDateStr();
            const evColor = /^#[0-9a-f]{3,8}$/i.test(String(parsed.color || '').trim()) ? String(parsed.color).trim() : '#2563EB';
            const evId = parsed.id || ('cal_' + now + '_' + Math.random().toString(36).slice(2, 6));
            if (!planner.calendarEvents.some(e => e.id === evId)) {
              planner.calendarEvents.push({
                id: evId,
                date: evDate,
                title: String(parsed.title).trim(),
                color: evColor,
                updatedAt: now
              });
            }
          } else if (action === 'update-cal-event' && id) {
            const ev = planner.calendarEvents.find(item => item.id === id);
            if (ev) {
              if (parsed.title !== undefined && String(parsed.title).trim()) ev.title = String(parsed.title).trim();
              if (parsed.color !== undefined && /^#[0-9a-f]{3,8}$/i.test(String(parsed.color).trim())) ev.color = String(parsed.color).trim();
              if (parsed.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) ev.date = parsed.date;
              ev.updatedAt = now;
            }
          } else if (action === 'delete-cal-event' && id) {
            planner.deletedCalendarEvents[id] = now;
            planner.calendarEvents = planner.calendarEvents.filter(item => item.id !== id);
          } else if (action === 'update-schedule-settings') {
            planner.scheduleSettings = normalizeScheduleSettings({
              ...planner.scheduleSettings,
              ...(parsed.scheduleSettings || parsed),
              updatedAt: now
            });
          } else if (action === 'add-goal' && parsed.text && parsed.text.trim()) {
            const goalId = parsed.id || ('goal_' + now + '_' + Math.random().toString(36).slice(2, 6));
            const existing = planner.goals.find(item => item.id === goalId);
            if (!existing) {
              const newGoal = {
                id: goalId,
                type: parsed.type || 'day',
                scopeKey: parsed.scopeKey || (parsed.type === 'month' ? getVnDateStr().slice(0, 7) : getVnDateStr()),
                text: parsed.text.trim(),
                priority: parsed.priority || 'medium',
                completed: false,
                createdAt: parsed.createdAt || new Date().toISOString(),
                updatedAt: parsed.updatedAt || now
              };
              planner.goals.push(newGoal);
            }
          } else if (action === 'toggle-goal' && id) {
            const g = planner.goals.find(item => item.id === id);
            if (g) {
              g.completed = !g.completed;
              g.updatedAt = now;
            }
          } else if (action === 'update-goal' && id) {
            const g = planner.goals.find(item => item.id === id);
            if (g) {
              if (parsed.text !== undefined) g.text = parsed.text.trim();
              if (parsed.priority !== undefined) g.priority = parsed.priority;
              if (parsed.completed !== undefined) g.completed = !!parsed.completed;
              g.updatedAt = now;
            }
          } else if (action === 'delete-goal' && id) {
            planner.deletedGoals[id] = now;
            planner.goals = planner.goals.filter(item => item.id !== id);
          } else if (action === 'reorder-goals' && Array.isArray(parsed.orderedIds)) {
            const idMap = new Map((planner.goals || []).map(g => [String(g.id), g]));
            if (parsed.movedGoalId && parsed.newType) {
              const moved = idMap.get(String(parsed.movedGoalId));
              if (moved) {
                moved.type = parsed.newType;
                if (parsed.newScopeKey) moved.scopeKey = parsed.newScopeKey;
                moved.updatedAt = now;
              }
            }
            const newGoals = [];
            for (const oId of parsed.orderedIds) {
              const item = idMap.get(String(oId));
              if (item) {
                newGoals.push(item);
                idMap.delete(String(oId));
              }
            }
            for (const remaining of idMap.values()) {
              newGoals.push(remaining);
            }
            planner.goals = newGoals;
          }

          syncDiscordPresenceFromActiveTimer(true);
          saveDatabase();
          broadcastPlannerUpdate();
          if (typeof triggerCloudSync === 'function') triggerCloudSync();

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            success: true,
            dailyPlanner: buildPlannerPayload(planner),
            serverTime: getCanonicalNow()
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ...buildPlannerPayload(appSettings.dailyPlanner),
      serverTime: getCanonicalNow()
    }));
  }

  // 10.2.0 API: Timeline Range & Break Analytics
  if (parsedUrl.pathname === '/api/daily-timeline') {
    if (!appSettings.dailyPlanner) appSettings.dailyPlanner = {};
    ensureDailyPlannerShape(appSettings.dailyPlanner);
    const now = getCanonicalNow();
    const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(parsedUrl.searchParams.get('date') || '')
      ? parsedUrl.searchParams.get('date')
      : getVnDateStr(now);
    const startParam = parsedUrl.searchParams.get('startDate');
    const daysCount = Math.max(1, Math.min(35, parseInt(parsedUrl.searchParams.get('days') || '1', 10) || 1));
    const effectiveStart = /^\d{4}-\d{2}-\d{2}$/.test(startParam || '') ? startParam : baseDate;

    const days = [];
    for (let i = 0; i < daysCount; i++) {
      const targetDate = msToVnParts(vnDateTimeToMs(effectiveStart, 12, 0, i)).dateStr;
      days.push(buildDayTimelineSummary(appSettings.dailyPlanner, targetDate, now));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      success: true,
      serverTime: now,
      startDate: effectiveStart,
      daysCount,
      scheduleSettings: normalizeScheduleSettings(appSettings.dailyPlanner.scheduleSettings),
      days
    }));
  }

  // 10.2.1 API: Two-Way Cloud Sync (Bidirectional merge between PC and Render)
  if (parsedUrl.pathname === '/api/sync-daily') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body || '{}');
          if (!appSettings.dailyPlanner) appSettings.dailyPlanner = {};
          ensureDailyPlannerShape(appSettings.dailyPlanner);

          const incomingChangedAt = incoming.activeTimerChangedAt || 0;
          const localChangedAt = appSettings.dailyPlanner.activeTimerChangedAt || 0;
          let timerChanged = false;

          // Merge activeTimer: newest change wins!
          if (incomingChangedAt > localChangedAt) {
            if (incoming.activeTimer) {
              appSettings.dailyPlanner.activeTimer = { ...incoming.activeTimer };
            } else {
              appSettings.dailyPlanner.activeTimer = null;
              if (incoming.lastTimerStoppedAt !== undefined) {
                appSettings.dailyPlanner.lastTimerStoppedAt = Math.max(
                  appSettings.dailyPlanner.lastTimerStoppedAt || 0,
                  incoming.lastTimerStoppedAt || 0
                );
              }
            }
            appSettings.dailyPlanner.activeTimerChangedAt = incomingChangedAt;
            timerChanged = true;
          }

          const plannerChanged = mergePlannerTasks(appSettings.dailyPlanner, incoming);
          const habitsChanged = mergeHabits(appSettings.habits, incoming.habits);

          if (timerChanged) {
            syncDiscordPresenceFromActiveTimer(true);
          }
          if (timerChanged || plannerChanged || habitsChanged) {
            saveDatabase();
            if (timerChanged || plannerChanged) {
              broadcastPlannerUpdate();
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            success: true,
            dailyPlanner: buildPlannerPayload(appSettings.dailyPlanner),
            habits: appSettings.habits,
            discordRpc: appSettings.discordRpc,
            serverTime: getCanonicalNow()
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
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
    const filename = parsedUrl.searchParams.get('filename');

    const base = (fs.existsSync(USER_DOWNLOADS_10SAT) || process.platform === 'win32') ? USER_DOWNLOADS_10SAT : BASE_10SAT;
    let folderToOpen = base;
    if (target === 'VERBAL') folderToOpen = path.join(base, 'VERBAL');
    else if (target === 'MATH') folderToOpen = path.join(base, 'MATH');

    if (!fs.existsSync(folderToOpen)) {
      try { fs.mkdirSync(folderToOpen, { recursive: true }); } catch (e) { }
    }

    let cmd = `powershell.exe -NoProfile -Command "Start-Process explorer.exe '${folderToOpen}'"`;
    if (filename) {
      const targetFilePath = path.join(folderToOpen, filename);
      if (fs.existsSync(targetFilePath)) {
        cmd = `powershell.exe -NoProfile -Command "explorer.exe /select, '${targetFilePath}'"`;
      }
    }

    exec(cmd, (err) => {
      if (err) console.error('Explorer error:', err);
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, folder: folderToOpen }));
  }

  // 12.1 API: Get or Set Windows Startup auto-run status
  if (parsedUrl.pathname === '/api/autostart') {
    const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const startupVbs = path.join(startupDir, 'EliasDiscordRPC.vbs');

    if (req.method === 'GET') {
      const isEnabled = fs.existsSync(startupVbs);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ enabled: isEnabled, path: startupVbs, isWindows: process.platform === 'win32' }));
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { enable } = JSON.parse(body || '{}');
          if (enable) {
            if (!fs.existsSync(startupDir)) {
              fs.mkdirSync(startupDir, { recursive: true });
            }
            const vbsContent = [
              'Set WshShell = CreateObject("WScript.Shell")',
              `WshShell.CurrentDirectory = "${__dirname}"`,
              'WshShell.Run "node server.js", 0, False',
              ''
            ].join('\r\n');
            fs.writeFileSync(startupVbs, vbsContent, 'utf8');
          } else {
            if (fs.existsSync(startupVbs)) {
              try { fs.unlinkSync(startupVbs); } catch (e) { }
            }
          }
          const isEnabled = fs.existsSync(startupVbs);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, enabled: isEnabled }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
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

  // PWA App Icons & Static Images
  if (parsedUrl.pathname === '/app_icon.png' || parsedUrl.pathname === '/app_icon_192.png' || parsedUrl.pathname === '/elias_avatar.png' || parsedUrl.pathname === '/stewie.png') {
    const iconName = parsedUrl.pathname.replace('/', '');
    const iconPath = path.join(__dirname, iconName);
    if (fs.existsSync(iconPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      return res.end(fs.readFileSync(iconPath));
    }
  }

  if (parsedUrl.pathname === '/favicon.ico' || parsedUrl.pathname === '/stewie.ico') {
    const icoPath = fs.existsSync(path.join(__dirname, 'favicon.ico')) ? path.join(__dirname, 'favicon.ico') : path.join(__dirname, 'stewie.ico');
    if (fs.existsSync(icoPath)) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=604800' });
      return res.end(fs.readFileSync(icoPath));
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

// Cloud Synchronization (Bidirectional merge between local PC and Render)
let isSyncing = false;

async function triggerCloudSync() {
  if (IS_CLOUD_INSTANCE || isSyncing) return;
  isSyncing = true;
  try {
    const startReq = Date.now();
    const payload = {
      tasks: appSettings.dailyPlanner?.tasks || [],
      goals: appSettings.dailyPlanner?.goals || [],
      sessions: appSettings.dailyPlanner?.sessions || [],
      calendarEvents: appSettings.dailyPlanner?.calendarEvents || [],
      scheduleSettings: normalizeScheduleSettings(appSettings.dailyPlanner?.scheduleSettings),
      deletedTasks: appSettings.dailyPlanner?.deletedTasks || {},
      deletedGoals: appSettings.dailyPlanner?.deletedGoals || {},
      deletedSessions: appSettings.dailyPlanner?.deletedSessions || {},
      deletedCalendarEvents: appSettings.dailyPlanner?.deletedCalendarEvents || {},
      daysHistory: appSettings.dailyPlanner?.daysHistory || {},
      habits: appSettings.habits || {},
      activeTimer: appSettings.dailyPlanner?.activeTimer || null,
      activeTimerChangedAt: appSettings.dailyPlanner?.activeTimerChangedAt || 0,
      lastTimerStoppedAt: appSettings.dailyPlanner?.lastTimerStoppedAt || 0
    };

    const res = await fetch(`${CLOUD_SYNC_URL}/api/sync-daily`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000)
    });

    if (res.ok) {
      const data = await res.json();
      const endReq = Date.now();
      const rtt = Math.max(0, endReq - startReq);

      if (data && data.serverTime) {
        // Calibrate clock offset with moving average
        const sampleOffset = data.serverTime - Math.floor(startReq + rtt / 2);
        if (cloudTimeOffset === 0) {
          cloudTimeOffset = sampleOffset;
        } else {
          cloudTimeOffset = Math.round(cloudTimeOffset * 0.7 + sampleOffset * 0.3);
        }
      }

      if (data && data.dailyPlanner) {
        let changed = false;
        const cloudPlanner = data.dailyPlanner;
        const cloudTimerChangedAt = cloudPlanner.activeTimerChangedAt || 0;
        const localTimerChangedAt = appSettings.dailyPlanner?.activeTimerChangedAt || 0;

        // Synchronize activeTimer: Both nodes use Canonical Cloud Time!
        if (cloudTimerChangedAt > localTimerChangedAt) {
          if (cloudPlanner.activeTimer) {
            appSettings.dailyPlanner.activeTimer = { ...cloudPlanner.activeTimer };
          } else {
            appSettings.dailyPlanner.activeTimer = null;
            if (cloudPlanner.lastTimerStoppedAt !== undefined) {
              appSettings.dailyPlanner.lastTimerStoppedAt = Math.max(
                appSettings.dailyPlanner.lastTimerStoppedAt || 0,
                cloudPlanner.lastTimerStoppedAt || 0
              );
            }
          }
          appSettings.dailyPlanner.activeTimerChangedAt = cloudTimerChangedAt;
          syncDiscordPresenceFromActiveTimer(true);
          changed = true;
        }

        if (mergePlannerTasks(appSettings.dailyPlanner, cloudPlanner)) {
          changed = true;
        }
        if (data.habits && mergeHabits(appSettings.habits, data.habits)) {
          changed = true;
        }

        if (changed) {
          saveDatabase();
          broadcastPlannerUpdate();
        }
      }

      if (data && data.discordRpc && typeof data.discordRpc === 'object') {
        const cloudRpc = data.discordRpc;
        const localRpcStr = JSON.stringify(appSettings.discordRpc || {});
        const cloudRpcStr = JSON.stringify(cloudRpc);
        if (localRpcStr !== cloudRpcStr) {
          appSettings.discordRpc = { ...appSettings.discordRpc, ...cloudRpc };
          initDiscordIpc();
          syncDiscordPresenceFromActiveTimer(true);
          saveDatabase();
        }
      }
    }
  } catch (err) {
    console.error('[Cloud Sync] Lỗi đồng bộ:', err.message);
  } finally {
    isSyncing = false;
  }
}

// Start server
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Startup] Cổng ${PORT} đã đang được chạy bởi một tiến trình khác.`);
    process.exit(0);
  }
});

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

  if (!IS_CLOUD_INSTANCE) {
    calibrateClockOffset();
    setTimeout(triggerCloudSync, 1000);
    // Real-time Cloud Synchronization loop: every 1.5 seconds
    setInterval(triggerCloudSync, 1500);
  }

  // 24/7 Keep-Alive System: Pings the public Render instance every 10 minutes to prevent sleep
  startKeepAliveSystem();
});

function startKeepAliveSystem() {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || CLOUD_SYNC_URL;
  const pingUrl = `${publicUrl}/api/ping`;
  const intervalMs = 10 * 60 * 1000; // 10 minutes (Render sleeps after 15 minutes of inactivity)

  async function sendKeepAlive() {
    try {
      const res = await fetch(pingUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'EliasKeepAlive247/1.0' }
      });
      if (res.ok) {
        console.log(`[Keep-Alive 24/7] Heartbeat OK: ${pingUrl}`);
      }
    } catch (e) {
      // Non-blocking
    }
  }

  // Initial ping 45 seconds after start
  setTimeout(sendKeepAlive, 45000);
  // Recurring ping every 10 minutes
  setInterval(sendKeepAlive, intervalMs);
}


