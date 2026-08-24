#!/usr/bin/env node
'use strict';

/*
 * 记加班 后端服务（零依赖 Node.js）
 * - 生产：监听 Unix Socket (MONITOR_SOCKET_PATH)，由 fnOS 经 /app/overtime-tracker 反代
 * - 开发：设置 PORT 即监听 TCP（便于本地冒烟测试）
 * - 数据持久化到 DATA_DIR/db.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, 'data');
const VAR_DIR = process.env.VAR_DIR || DATA_DIR;
const SOCKET_PATH = (process.env.MONITOR_SOCKET_PATH || '').trim();
const BASE_PATH = (process.env.BASE_PATH || '/app/overtime-tracker').replace(/\/+$/, '');
const PORT = parseInt(process.env.PORT || '8787', 10);
const LOG_FILE = path.join(VAR_DIR, 'info.log');
const APP_VERSION = '1.1.1';

const UI_DIR = path.join(APP_DIR, 'ui');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  settings: { hourlyRate: 50, recurringFees: [] },
  records: []
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!data.settings) data.settings = JSON.parse(JSON.stringify(DEFAULT_DB.settings));
      if (!Array.isArray(data.records)) data.records = [];
      if (!Array.isArray(data.settings.presets)) data.settings.presets = [];
      return data;
    }
  } catch (e) {
    console.error('loadDB error:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('saveDB error:', e.message);
    return false;
  }
}

let db = loadDB();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e7) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const id = (typeof r.id === 'string' && r.id) ? r.id : crypto.randomUUID();
  const date = (typeof r.date === 'string' && r.date) ? r.date : new Date().toISOString().slice(0, 10);
  const hours = round2(Number(r.hours) || 0);
  const note = (typeof r.note === 'string') ? r.note : '';
  const items = Array.isArray(r.items)
    ? r.items.map((it) => ({ name: String(it.name || '').trim(), amount: round2(Number(it.amount) || 0) }))
    : [];
  const createdAt = (typeof r.createdAt === 'number') ? r.createdAt : Date.now();
  return { id, date, hours, note, items, createdAt };
}

function recordSubtotal(rec, rate) {
  const base = (Number(rec.hours) || 0) * (Number(rate) || 0);
  const extra = (rec.items || []).reduce((s, it) => s + (Number(it.amount) || 0), 0);
  return round2(base + extra);
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(UI_DIR, rel));
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const idx = path.join(UI_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(fs.readFileSync(idx));
      return;
    }
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
}

function serveDebug(res) {
  let logTail = '';
  try {
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      logTail = lines.slice(-40).join('\n');
    }
  } catch (e) { logTail = '无法读取日志: ' + e.message; }
  const envInfo = {
    APP_DIR, DATA_DIR, VAR_DIR, SOCKET_PATH, BASE_PATH, PORT,
    node: process.version, platform: process.platform, pid: process.pid,
    dbExists: fs.existsSync(DB_FILE)
  };
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记加班 · 诊断</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;color:#2b2f36;padding:24px;line-height:1.6}
h1{font-size:18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:12px 0;white-space:pre-wrap;word-break:break-all;font-size:13px}
code{background:#eef0f3;padding:2px 6px;border-radius:6px}</style></head>
<body><h1>记加班 · 运行诊断</h1>
<div class="card"><b>环境</b>\n${JSON.stringify(envInfo, null, 2)}</div>
<div class="card"><b>日志 (末尾 40 行)</b>\n${escapeHtml(logTail) || '(空)'}</div>
<p><a href="${BASE_PATH || '/'}">← 返回应用</a></p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compareVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 检查 GitHub 上的最新版本（对齐 fnos-hermes-agent 的「更新页自动拉取版本对比」）
// 优先读 fnpack.json（第三方源索引，无 API 限流），失败再退回 GitHub Releases API
async function checkUpdate() {
  const current = APP_VERSION;
  const REPO = 'bubujun1/overtime-tracker';
  const sources = [
    { url: 'https://raw.githubusercontent.com/' + REPO + '/main/fnpack.json', type: 'fnpack' },
    { url: 'https://api.github.com/repos/' + REPO + '/releases/latest', type: 'github' }
  ];
  let latest = null, downloadUrl = null, publishedAt = null, notes = '';
  for (const s of sources) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(s.url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'overtime-tracker', 'Accept': 'application/json' }
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      const j = await r.json();
      if (s.type === 'fnpack') {
        const app = j['overtime-tracker'] || (j.apps && j.apps['overtime-tracker']) || j;
        latest = app.version;
        downloadUrl = app.download_url || null;
        const hist = app.history || {};
        notes = hist['v' + app.version] || Object.values(hist).join('\n') || '';
      } else {
        latest = j.tag_name;
        publishedAt = j.published_at || null;
        notes = j.body || '';
        const asset = (j.assets || []).find((a) => String(a.name).toLowerCase().endsWith('.fpk'));
        downloadUrl = asset ? asset.browser_download_url : null;
      }
      if (latest) break;
    } catch (e) {
      console.error('[check-update] source failed:', s.url, e.message);
    }
  }
  if (!latest) {
    return { ok: false, error: '无法连接更新服务器，请检查网络后重试', current };
  }
  return {
    ok: true,
    current,
    latest,
    hasUpdate: compareVersion(latest, current) > 0,
    downloadUrl: downloadUrl || null,
    publishedAt: publishedAt || null,
    notes: String(notes || '').slice(0, 600)
  };
}

async function handleApi(req, res, apiPath, method) {
  const parts = apiPath.split('/').filter(Boolean);
  const head = parts[0];

  if (head === 'check-update' && method === 'GET') {
    try {
      const r = await checkUpdate();
      return sendJSON(res, 200, r);
    } catch (e) {
      return sendJSON(res, 200, { ok: false, error: '检查更新失败: ' + e.message, current: APP_VERSION });
    }
  }

  // 一键更新：下载新版本 .fpk 并尝试触发 fnOS 覆盖安装（对齐 hermes-agent 的"直接更新覆盖"体验）
  if (head === 'update' && method === 'POST') {
    try {
      const info = await checkUpdate();
      if (!info.ok) return sendJSON(res, 200, { ok: false, error: info.error, phase: 'check' });
      if (!info.hasUpdate) return sendJSON(res, 200, { ok: false, error: '当前已是最新版本 v' + info.current, phase: 'check' });
      if (!info.downloadUrl) return sendJSON(res, 200, { ok: false, error: '未获取到下载地址', phase: 'check' });

      const updateDir = path.join(VAR_DIR, 'updates');
      fs.mkdirSync(updateDir, { recursive: true });
      const fpkPath = path.join(updateDir, 'overtime-tracker-' + info.latest + '.fpk');

      console.log('[update] downloading', info.downloadUrl, '->', fpkPath);
      const dlCtrl = new AbortController();
      const dlTimer = setTimeout(() => dlCtrl.abort(), 120000); // 2 分钟超时
      const dlRes = await fetch(info.downloadUrl, {
        signal: dlCtrl.signal,
        headers: { 'User-Agent': 'overtime-tracker-updater' }
      });
      clearTimeout(dlTimer);
      if (!dlRes.ok || !dlRes.body) {
        return sendJSON(res, 200, { ok: false, error: '下载失败: HTTP ' + dlRes.status, phase: 'download' });
      }

      const buf = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(fpkPath, buf);
      console.log('[update] downloaded', buf.length, 'bytes ->', fpkPath);

      // 尝试调用 fnOS 应用中心 API 触发安装（最佳努力）
      let installResult = null;
      try {
        // 方式1：尝试通过 trim_app_center 的 CGI 接口
        const host = process.env.FNOS_HOST || '127.0.0.1';
        const port = parseInt(process.env.FNOS_PORT || '8082', 10);
        const installApi = 'http://' + host + ':' + port + '/cgi-bin/appcenter.cgi';
        // 注意：此接口为内部接口，不同 fnOS 版本可能不同；失败不影响已下载的 fpk
        const form = new URLSearchParams();
        form.append('action', 'install');
        form.append('file_path', fpkPath);
        form.append('force_upgrade', '1');

        const installRes = await fetch(installApi, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(10000)
        });
        installResult = { status: installRes.status, ok: installRes.ok };
        console.log('[update] install attempt:', installResult);
      } catch (eInstall) {
        installResult = { error: eInstall.message };
        console.log('[update] install attempt failed (non-fatal):', eInstall.message);
      }

      return sendJSON(res, 200, {
        ok: true,
        phase: 'done',
        version: info.latest,
        fpkPath: fpkPath,
        fpkSize: buf.length,
        installAttempt: installResult,
        message: '新版本 v' + info.latest + ' 已下载完成'
      });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, error: '更新失败: ' + e.message, phase: 'unknown' });
    }
  }

  if (head === 'state' && method === 'GET') {
    const rate = db.settings.hourlyRate;
    const enriched = db.records.map((r) => ({ ...r, subtotal: recordSubtotal(r, rate) }));
    return sendJSON(res, 200, { settings: db.settings, records: enriched });
  }

  if (head === 'summary' && method === 'GET') {
    const rate = db.settings.hourlyRate || 0;
    let totalHours = 0, totalCost = 0;
    for (const r of db.records) {
      totalHours += Number(r.hours) || 0;
      totalCost += recordSubtotal(r, rate);
    }
    // 周期性固定费用：月费全额计入，季费折算为月（÷3）
    let monthlyRecurring = 0;
    const fees = (db.settings && db.settings.recurringFees) || [];
    for (const f of fees) {
      const amt = Number(f.amount) || 0;
      if (f.cycle === 'quarterly') monthlyRecurring += amt / 3;
      else monthlyRecurring += amt;
    }
    return sendJSON(res, 200, {
      totalHours: round2(totalHours),
      totalCost: round2(totalCost),
      monthlyRecurring: round2(monthlyRecurring),
      grandTotal: round2(totalCost + monthlyRecurring),
      recordCount: db.records.length
    });
  }

  if (head === 'export' && method === 'GET') {
    try {
      const payload = JSON.stringify(db, null, 2);
      const fname = 'overtime-backup-' + dateStamp(new Date()) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + fname + '"'
      });
      res.end(payload);
      return;
    } catch (e) {
      return sendJSON(res, 500, { error: 'export failed' });
    }
  }

  if (head === 'import' && method === 'POST') {
    let raw;
    try { raw = (await readBody(req)) || '{}'; }
    catch { return sendJSON(res, 400, { error: 'invalid body' }); }
    let incoming;
    try { incoming = JSON.parse(raw); }
    catch { return sendJSON(res, 400, { error: 'invalid json' }); }
    if (!incoming || typeof incoming !== 'object') return sendJSON(res, 400, { error: 'bad structure' });
    const mode = (req.headers['x-import-mode'] || 'replace').toString().trim().toLowerCase();
    try {
      if (mode === 'merge') {
        // 合并模式：以 id 去重，导入的记录覆盖同名 id，其余追加
        const incomingRecords = Array.isArray(incoming.records) ? incoming.records : [];
        const byId = {};
        let i;
        for (i = 0; i < db.records.length; i++) byId[db.records[i].id] = db.records[i];
        let merged = 0;
        for (i = 0; i < incomingRecords.length; i++) {
          const rec = normalizeRecord(incomingRecords[i]);
          if (!rec) continue;
          byId[rec.id] = rec;
          merged++;
        }
        db.records = [];
        for (const k in byId) {
          if (Object.prototype.hasOwnProperty.call(byId, k)) db.records.push(byId[k]);
        }
        if (incoming.settings && typeof incoming.settings === 'object') {
          if (typeof incoming.settings.hourlyRate === 'number') db.settings.hourlyRate = round2(incoming.settings.hourlyRate);
          if (Array.isArray(incoming.settings.presets)) {
            db.settings.presets = incoming.settings.presets
              .filter((p) => p && typeof p.name === 'string')
              .map((p) => ({ name: String(p.name).trim(), amount: round2(Number(p.amount) || 0) }));
          }
        }
        saveDB();
        return sendJSON(res, 200, { ok: true, mode: 'merge', records: db.records.length });
      }
      // 默认 replace：整体替换（校验结构）
      const next = { settings: JSON.parse(JSON.stringify(DEFAULT_DB.settings)), records: [] };
      if (incoming.settings && typeof incoming.settings === 'object') {
        if (typeof incoming.settings.hourlyRate === 'number') next.settings.hourlyRate = round2(incoming.settings.hourlyRate);
        if (Array.isArray(incoming.settings.presets)) {
          next.settings.presets = incoming.settings.presets
            .filter((p) => p && typeof p.name === 'string')
            .map((p) => ({ name: String(p.name).trim(), amount: round2(Number(p.amount) || 0) }));
        }
      }
      if (Array.isArray(incoming.records)) {
        let j;
        for (j = 0; j < incoming.records.length; j++) {
          const rec = normalizeRecord(incoming.records[j]);
          if (rec) next.records.push(rec);
        }
      }
      db = next;
      saveDB();
      return sendJSON(res, 200, { ok: true, mode: 'replace', records: db.records.length });
    } catch (e) {
      return sendJSON(res, 500, { error: 'import failed: ' + e.message });
    }
  }

  if (head === 'settings') {
    if (method === 'GET') return sendJSON(res, 200, db.settings);
    let patch;
    try { patch = JSON.parse((await readBody(req)) || '{}'); }
    catch { return sendJSON(res, 400, { error: 'invalid json' }); }
    if (typeof patch.hourlyRate === 'number') db.settings.hourlyRate = round2(patch.hourlyRate);
    // 周期性固定费用（月/季度）
    if (Array.isArray(patch.recurringFees)) {
      db.settings.recurringFees = patch.recurringFees
        .filter((f) => f && typeof f.name === 'string')
        .map((f) => ({
          name: String(f.name).trim(),
          amount: round2(Number(f.amount) || 0),
          cycle: (f.cycle === 'quarterly') ? 'quarterly' : 'monthly'
        }));
    }
    saveDB();
    return sendJSON(res, 200, db.settings);
  }

  if (head === 'records') {
    if (method === 'GET') {
      const rate = db.settings.hourlyRate;
      const enriched = db.records.map((r) => ({ ...r, subtotal: recordSubtotal(r, rate) }));
      return sendJSON(res, 200, enriched);
    }
    if (method === 'POST') {
      let r;
      try { r = JSON.parse((await readBody(req)) || '{}'); }
      catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      const rec = {
        id: crypto.randomUUID(),
        date: typeof r.date === 'string' && r.date ? r.date : new Date().toISOString().slice(0, 10),
        hours: round2(Number(r.hours) || 0),
        note: typeof r.note === 'string' ? r.note : '',
        items: Array.isArray(r.items)
          ? r.items.map((it) => ({ name: String(it.name || '').trim(), amount: round2(Number(it.amount) || 0) }))
          : [],
        createdAt: Date.now()
      };
      db.records.push(rec);
      saveDB();
      return sendJSON(res, 201, { ...rec, subtotal: recordSubtotal(rec, db.settings.hourlyRate) });
    }
    if ((method === 'PUT' || method === 'DELETE') && parts[1]) {
      const id = parts[1];
      const idx = db.records.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
      if (method === 'DELETE') {
        db.records.splice(idx, 1);
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      let r;
      try { r = JSON.parse((await readBody(req)) || '{}'); }
      catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      const rec = db.records[idx];
      if (typeof r.date === 'string' && r.date) rec.date = r.date;
      if (typeof r.hours === 'number') rec.hours = round2(r.hours);
      if (typeof r.note === 'string') rec.note = r.note;
      if (Array.isArray(r.items)) {
        rec.items = r.items.map((it) => ({ name: String(it.name || '').trim(), amount: round2(Number(it.amount) || 0) }));
      }
      saveDB();
      return sendJSON(res, 200, { ...rec, subtotal: recordSubtotal(rec, db.settings.hourlyRate) });
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (BASE_PATH && urlPath.startsWith(BASE_PATH)) {
      urlPath = urlPath.slice(BASE_PATH.length) || '/';
    }
    const method = req.method || 'GET';

    if (urlPath === '/debug' && method === 'GET') return serveDebug(res);
    if (urlPath.startsWith('/api/')) {
      return await handleApi(req, res, urlPath.slice(4), method);
    }
    return serveStatic(res, urlPath);
  } catch (e) {
    console.error('request error:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal' });
    else res.end();
  }
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

/* ====== 自动备份 ====== */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_DAYS = 3;

function dateStamp(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function pad2(n) { return String(n).length < 2 ? '0' + String(n) : String(n); }

function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = dateStamp(new Date());
    const dest = path.join(BACKUP_DIR, stamp + '.json');
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, dest);
    }
    cleanupBackups();
    console.log('[backup] done ' + stamp);
  } catch (e) {
    console.error('[backup] error:', e.message);
  }
}

function cleanupBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    while (files.length > BACKUP_KEEP_DAYS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); console.log('[backup] removed old ' + old); }
      catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.error('[backup] cleanup error:', e.message);
  }
}

function scheduleDailyBackup() {
  // 立即清理一次，保证启动时无过期备份
  cleanupBackups();
  // 计算到下一个凌晨 00:00 的毫秒数
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
  let delay = next.getTime() - now.getTime();
  if (delay < 0) delay = 24 * 3600 * 1000;
  setTimeout(function tick() {
    runBackup();
    // 每 24 小时执行一次
    setTimeout(tick, 24 * 3600 * 1000);
  }, delay);
  console.log('[backup] scheduled, first run in ' + Math.round(delay / 1000) + 's');
}

function start() {
  scheduleDailyBackup();
  if (SOCKET_PATH) {
    try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ }
    server.listen(SOCKET_PATH, () => {
      try { fs.chmodSync(SOCKET_PATH, 0o777); } catch (e) { /* ignore */ }
      console.log('listening on socket ' + SOCKET_PATH);
    });
  } else {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('listening on http://0.0.0.0:' + PORT);
    });
  }
  server.on('error', (e) => { console.error('server error:', e.message); process.exit(1); });
}

start();
