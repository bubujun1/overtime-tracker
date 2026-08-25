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
const { spawn, execSync } = require('child_process');

const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, 'data');
const VAR_DIR = process.env.VAR_DIR || DATA_DIR;
const SOCKET_PATH = (process.env.MONITOR_SOCKET_PATH || '').trim();
const BASE_PATH = (process.env.BASE_PATH || '/app/overtime-tracker').replace(/\/+$/, '');
const PORT = parseInt(process.env.PORT || '8787', 10);
const LOG_FILE = path.join(VAR_DIR, 'info.log');
const APP_VERSION = '1.2.0';

const UI_DIR = path.join(APP_DIR, 'ui');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  settings: { hourlyRate: 50, monthlyRates: {}, recurringFees: [] },
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

/* =========================================================================
 * 签到模块（自动签到引擎，移植自便阅记 checkin，独立命名空间，不污染 overtime 数据）
 * 数据存 DATA_DIR/checkin.json；路由前缀 /api/checkin/*；函数加 ck 前缀避免与现有冲突。
 * 参考：便阅记《签到功能说明》+ QD(qiandao) 自动签到项目。Cookie 采用手动粘贴（本地零依赖）。
 * ========================================================================= */
const CHECKIN_FILE = path.join(DATA_DIR, 'checkin.json');

/* 站点模板（参照 GitHub 自动签到项目的真实接口） */
const ckTemplates = [
  { key: 'custom', name: '自定义（手动配置）', emoji: '🌐', type: 'api', method: 'GET', url: '', baseHeaders: {}, success: null, keyword: '', note: '手动填请求地址 / 方法 / 请求头 / 成功关键词。适合任何开放接口的站点。' },
  { key: 'bilibili-live', name: 'B站直播签到', emoji: '📺', type: 'api', method: 'GET', url: 'https://api.live.bilibili.com/xlive/web-ucenter/v1/sign/DoSign', baseHeaders: { 'Referer': 'https://live.bilibili.com/', 'Origin': 'https://live.bilibili.com' }, csrf: { cookieKey: 'bili_jct', queryKeys: ['csrf_token', 'csrf'] }, body: '', success: { type: 'json', path: 'code', equals: [0, 101104] }, note: '需登录 Cookie（含 SESSDATA 和 bili_jct）。把浏览器里的 Cookie 整串粘贴到「登录凭证 Cookie」即可，引擎自动提取 bili_jct 作为 csrf 注入查询参数。成功返回 code=0，今日已签返回 101104。' },
  { key: 'discuz', name: 'Discuz 论坛签到（通用）', emoji: '🏷️', type: 'formSign', method: 'POST', url: 'https://{host}/forum.php?mod=taskworker&id=1&item=1', getUrl: 'https://{host}/forum.php', baseHeaders: { 'Referer': 'https://{host}/' }, successKeyword: '成功', note: '把 {host} 换成你的论坛域名（如 www.hostloc.com）。需登录 Cookie。先抓页面 formhash 再 POST 完成签到，多数 Discuz 论坛通用。' },
  { key: 'tieba', name: '百度贴吧签到', emoji: '🔥', type: 'tiebaOneClick', method: 'POST', url: 'https://tieba.baidu.com/sign/add', baseHeaders: { 'Referer': 'https://tieba.baidu.com/' }, note: '一键签到所有关注的吧（复刻贴吧网页版「一键签到」）。需登录 Cookie（含 BDUSS）。把浏览器里的 Cookie 整串粘贴到「登录凭证 Cookie」即可。引擎会先校验登录态，再逐个吧签到，返回每个吧的结果。' }
];

function ckDefaultState() {
  return {
    v: 2, daily: {}, sites: [], siteLogs: {}, scheduleLog: {},
    settings: { theme: 'light', autoRun: true, proxy: '', autoDaily: '09:00', notify: false, backupThreshold: 20 },
    meta: { createdAt: Date.now(), lastBackupAt: null, additionsSinceBackup: 0, cleared: false }
  };
}
function ckUid() { return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function ckDs(d) { d = d || new Date(); const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0'); return y + '-' + m + '-' + da; }
function ckNowHM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function ckGetPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function ckSafeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function ckSetFormField(body, k, v) {
  const enc = encodeURIComponent(v);
  if (!body) return k + '=' + enc;
  if (typeof body === 'string') return body + (body.indexOf('=') >= 0 ? '&' : '') + k + '=' + enc;
  if (typeof body === 'object') { body[k] = v; return body; }
  return body;
}
function ckAppendQuery(url, k, v) { const sep = url.indexOf('?') >= 0 ? '&' : '?'; return url + sep + encodeURIComponent(k) + '=' + encodeURIComponent(v); }
function ckNormalizeSchedule(v) {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{2}:\d{2}$/.test(v) ? v : null;
  if (Array.isArray(v)) { const arr = v.filter(x => typeof x === 'string' && /^\d{2}:\d{2}$/.test(x)); if (arr.length === 0) return null; if (arr.length === 1) return arr[0]; return arr; }
  return null;
}
function ckToSlots(schedule) { if (!schedule) return []; if (Array.isArray(schedule)) return schedule.filter(x => /^\d{2}:\d{2}$/.test(x)); return [schedule]; }
function ckDemoSites() {
  return [
    { id: ckUid(), name: '百度贴吧签到', emoji: '🔥', group: '社区', schedule: '09:00', enabled: true, demo: true, tpl: null, note: '一键签到所有关注的吧。需登录 Cookie（含 BDUSS）：粘贴到「登录凭证 Cookie」。引擎先校验登录态，再逐个吧签到，返回每个吧的结果。', req: { url: 'https://tieba.baidu.com/sign/add', method: 'POST', headers: '{"Referer":"https://tieba.baidu.com/"}', type: 'tiebaOneClick' } },
    { id: ckUid(), name: '示例论坛签到', emoji: '🏷️', group: '论坛', schedule: '21:00', enabled: true, demo: true, tpl: null, note: 'Discuz 类论坛，把 host 和 Cookie 换成你自己的', req: { type: 'formSign', url: 'https://www.hostloc.com/forum.php?mod=taskworker&id=1&item=1', getUrl: 'https://www.hostloc.com/forum.php', method: 'POST', headers: '{"Cookie":"你的论坛 Cookie","Referer":"https://www.hostloc.com/"}', body: '' } }
  ];
}
function ckExpandTemplate(site) {
  const t = site.tpl ? ckTemplates.find(x => x.key === site.tpl) : null;
  if (!t) return site;
  const req = site.req || {};
  if (!req.url) req.url = t.url;
  if (!req.method) req.method = t.method || 'GET';
  if (!req.headers && t.baseHeaders) req.headers = JSON.stringify(t.baseHeaders, null, 0);
  if (t.getUrl && !req.getUrl) req.getUrl = t.getUrl;
  if (t.type && !req.type) req.type = t.type;
  if (t.success) req.success = t.success;
  if (t.keyword && !req.keyword) req.keyword = t.keyword;
  if (site.tpl === 'bilibili-live' && !req.body && t.csrf) req.body = (t.csrf.formKeys || []).map(k => k + '=你的' + t.csrf.cookieKey).join('&');
  if (!site.note && t.note) site.note = t.note;
  site.req = req; site.tpl = null;
  return site;
}
function ckNormalize(s) {
  if (!s || typeof s !== 'object') throw new Error('格式不正确');
  const d = ckDefaultState();
  if (s.daily && typeof s.daily === 'object') { for (const k in s.daily) if (typeof s.daily[k] === 'number') d.daily[k] = s.daily[k]; }
  if (Array.isArray(s.sites)) {
    d.sites = s.sites.filter(x => x && typeof x === 'object' && x.name).map(x => ({
      id: x.id || ckUid(), name: String(x.name), emoji: String(x.emoji || ''), group: String(x.group || ''),
      schedule: ckNormalizeSchedule(x.schedule), enabled: x.enabled !== false, demo: !!x.demo, tpl: typeof x.tpl === 'string' ? x.tpl : null,
      cookie: String(x.cookie || ''), req: (x.req && typeof x.req === 'object') ? x.req : {},
      lastRun: x.lastRun || null, lastResult: (x.lastResult && typeof x.lastResult === 'object') ? x.lastResult : null
    }));
  }
  if (s.siteLogs && typeof s.siteLogs === 'object') {
    for (const sid in s.siteLogs) if (s.siteLogs[sid] && typeof s.siteLogs[sid] === 'object') {
      const m = {}; for (const dt in s.siteLogs[sid]) if (typeof s.siteLogs[sid][dt] === 'number') m[dt] = s.siteLogs[sid][dt];
      d.siteLogs[sid] = m;
    }
  }
  if (s.scheduleLog && typeof s.scheduleLog === 'object') {
    const sl = {};
    for (const dt in s.scheduleLog) {
      if (typeof s.scheduleLog[dt] !== 'object' || !s.scheduleLog[dt]) continue;
      const m = {};
      for (const sid in s.scheduleLog[dt]) if (Array.isArray(s.scheduleLog[dt][sid])) m[sid] = s.scheduleLog[dt][sid].filter(t => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t));
      sl[dt] = m;
    }
    d.scheduleLog = sl;
  }
  if (s.settings && typeof s.settings === 'object') {
    const st = s.settings;
    d.settings.theme = st.theme === 'dark' ? 'dark' : 'light';
    d.settings.autoRun = !!st.autoRun;
    d.settings.proxy = typeof st.proxy === 'string' ? st.proxy : '';
    d.settings.autoDaily = (typeof st.autoDaily === 'string' && /^\d{2}:\d{2}$/.test(st.autoDaily)) ? st.autoDaily : '09:00';
    d.settings.notify = !!st.notify;
    d.settings.backupThreshold = (typeof st.backupThreshold === 'number' && st.backupThreshold > 0) ? st.backupThreshold : 20;
  }
  if (s.meta && typeof s.meta === 'object') {
    d.meta.createdAt = s.meta.createdAt || Date.now();
    d.meta.lastBackupAt = s.meta.lastBackupAt || null;
    d.meta.additionsSinceBackup = (typeof s.meta.additionsSinceBackup === 'number') ? s.meta.additionsSinceBackup : 0;
    d.meta.cleared = !!s.meta.cleared;
  }
  return d;
}

let ck = ckDefaultState();
function ckLoad() {
  let raw = null;
  try { raw = fs.readFileSync(CHECKIN_FILE, 'utf8'); } catch (e) { raw = null; }
  if (raw === null) { ck = ckDefaultState(); ck.sites = ckDemoSites(); ckSave(); return; }
  try {
    ck = ckNormalize(JSON.parse(raw));
    ck.sites = ck.sites.map(s => (s.tpl ? ckExpandTemplate(s) : s));
    if (ck.sites.length === 0 && !ck.meta.cleared) { ck.sites = ckDemoSites(); ckSave(); }
  } catch (e) {
    console.error('[checkin] 数据损坏，已重置：', e.message);
    ck = ckDefaultState(); ck.meta.corrupted = true; ckSave();
  }
}
function ckSave() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CHECKIN_FILE, JSON.stringify(ck, null, 2), 'utf8'); } catch (e) { console.error('[checkin] 保存失败：', e.message); } }

function ckResolveCfg(site) {
  const t = site.tpl ? ckTemplates.find(x => x.key === site.tpl) : null;
  const base = t ? JSON.parse(JSON.stringify(t)) : { type: 'api', method: 'GET', baseHeaders: {}, success: null, keyword: '' };
  const req = site.req || {};
  const cfg = Object.assign({}, base);
  if (req.url) cfg.url = req.url;
  if (req.getUrl) cfg.getUrl = req.getUrl;
  if (req.method) cfg.method = req.method;
  if (req.headers) cfg.baseHeaders = Object.assign({}, cfg.baseHeaders, (ckSafeJson(req.headers) || {}));
  if (req.body !== undefined) cfg.body = req.body;
  if (req.keyword) cfg.keyword = req.keyword;
  if (req.success) cfg.success = req.success;
  if (req.csrf) cfg.csrf = req.csrf;
  if (req.token) cfg.token = req.token;
  if (req.type) cfg.type = req.type;
  cfg.cookie = site.cookie || req.cookie || '';
  return cfg;
}

async function ckRun(site) {
  const cfg = ckResolveCfg(site);
  if (!cfg.url) return { ok: false, reason: '未配置请求地址' };
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; checkin-app/1.0)';
  const headers = Object.assign({ 'User-Agent': UA }, cfg.baseHeaders || {});
  if (!headers['Cookie'] && !headers['cookie'] && site.cookie) headers['Cookie'] = site.cookie;
  const cookie = (headers['Cookie'] || headers['cookie'] || site.cookie || '').trim();
  if (cfg.type === 'tiebaOneClick' || (cfg.url && cfg.url.indexOf('tieba.baidu.com/sign/add') >= 0)) return await ckTieba(cookie);
  const method = (cfg.method || 'GET').toUpperCase();
  const rawUrl = cfg.url;
  const proxy = ck.settings.proxy ? ck.settings.proxy.trim() : '';
  let target = proxy ? (proxy.indexOf('{url}') >= 0 ? proxy.replace('{url}', encodeURIComponent(rawUrl)) : proxy + encodeURIComponent(rawUrl)) : rawUrl;
  let body = cfg.body != null ? cfg.body : null;
  if (cfg.csrf && cookie) {
    const m = cookie.match(new RegExp(cfg.csrf.cookieKey + '=([^;]+)'));
    if (m) {
      (cfg.csrf.formKeys || []).forEach(k => { if (body != null) body = ckSetFormField(body, k, m[1]); });
      (cfg.csrf.queryKeys || []).forEach(k => { target = ckAppendQuery(target, k, m[1]); });
    }
  }
  if (cfg.token && cookie) {
    try {
      const tkRes = await fetch(cfg.token.url, { headers: { 'Cookie': cookie, 'User-Agent': UA } });
      const tkJson = await tkRes.json();
      const tk = ckGetPath(tkJson, cfg.token.jsonPath);
      if (tk) {
        if (cfg.token.formKey && body != null) body = ckSetFormField(body, cfg.token.formKey, tk);
        if (cfg.token.queryKey) target = ckAppendQuery(target, cfg.token.queryKey, tk);
      }
    } catch (e) { /* 取 token 失败则继续 */ }
  }
  try {
    let text, status;
    if (cfg.type === 'formSign') {
      const pageRes = await fetch(cfg.getUrl || rawUrl, { headers: { 'Cookie': cookie, 'User-Agent': UA } });
      const pageText = await pageRes.text();
      const fm = pageText.match(/name="formhash"[^>]*value="([a-f0-9]{6,})"|formhash=([a-f0-9]{6,})|FORMHASH["']?\s*:\s*"([a-f0-9]{6,})"/i);
      const formhash = fm ? (fm[1] || fm[2] || fm[3]) : null;
      if (!formhash) return { ok: false, reason: '未能提取 formhash（Cookie 失效或页面改版）' };
      let fb = (cfg.formBody || 'formhash=' + formhash);
      if (cfg.csrf && cookie) { const m = cookie.match(new RegExp(cfg.csrf.cookieKey + '=([^;]+)')); if (m) (cfg.csrf.formKeys || []).forEach(k => fb += '&' + k + '=' + encodeURIComponent(m[1])); }
      const r = await fetch(target, { method, headers: Object.assign({}, headers, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: fb });
      text = await r.text(); status = r.status;
    } else {
      const isForm = (typeof body === 'string') && body.trim().charAt(0) !== '{';
      const sendHeaders = Object.assign({}, headers);
      if (isForm) sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const r = await fetch(target, { method, headers: sendHeaders, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      text = await r.text(); status = r.status;
    }
    let ok = (status >= 200 && status < 300);
    if (cfg.success && cfg.success.type === 'json') {
      try {
        const j = JSON.parse(text);
        const v = ckGetPath(j, cfg.success.path);
        if (cfg.success.notEquals !== undefined) ok = (v !== cfg.success.notEquals);
        else if (Array.isArray(cfg.success.equals)) ok = (cfg.success.equals.indexOf(v) >= 0);
        else ok = (v === cfg.success.equals);
      } catch (e) { ok = false; }
    } else if (cfg.success && cfg.success.type === 'text') {
      ok = text.indexOf(cfg.success.contains) >= 0;
    } else if (cfg.keyword) {
      ok = text.indexOf(cfg.keyword) >= 0;
    } else {
      const j = ckSafeJson(text);
      if (j && typeof j === 'object') {
        if (j.result === 'error' || j.result === 'fail' || j.success === false ||
            (typeof j.code === 'number' && j.code < 0) || j.errcode || j.errno ||
            (j.error && j.error !== 0 && j.error !== '0') || j.errMsg || j.errmsg) ok = false;
      }
    }
    let reason = null;
    if (!ok) {
      if (status < 200 || status >= 300) reason = 'HTTP ' + status + '（请求被拒或服务不可用）';
      else {
        const j = ckSafeJson(text);
        const msg = j && (j.msg || j.message || j.reason || (j.data && j.data.msg));
        reason = '接口已响应，但未签到成功' + (msg ? '（' + msg + '）' : '（可能需验证码 / 今日已签过 / 参数不对）');
      }
    }
    return { ok, status, reason, snippet: text.slice(0, 220) };
  } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}

function ckSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function ckTieba(cookie) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; checkin-app/1.0)';
  if (!cookie) return { ok: false, reason: '未配置 Cookie。请在「登录凭证 Cookie」粘贴贴吧登录态（含 BDUSS）。' };
  let mo;
  try {
    const r = await fetch('https://tieba.baidu.com/mo/q/newmoindex?', { headers: { 'Cookie': cookie, 'User-Agent': UA, 'Referer': 'https://tieba.baidu.com/' } });
    mo = await r.json();
  } catch (e) { return { ok: false, reason: '获取贴吧登录态失败（网络异常）：' + (e && e.message || e) }; }
  if (!mo || mo.no !== 0 || !mo.data || !mo.data.uid || !Array.isArray(mo.data.like_forum)) {
    return { ok: false, status: 200, reason: 'Cookie 未登录或已失效（请重新登录贴吧后再试）。', snippet: JSON.stringify(mo || {}).slice(0, 220) };
  }
  const tbs = mo.data.tbs;
  const forums = (mo.data.like_forum || []).map(f => (f && (f.forum_name || f.name))).filter(Boolean);
  if (!forums.length) return { ok: false, reason: '未获取到关注的吧（请先在贴吧关注一些吧，或重新登录后重试）。' };
  let success = 0, already = 0, needCaptcha = [], failed = [], skipped = [];
  const details = [];
  for (let i = 0; i < forums.length; i++) {
    const name = forums[i];
    const body = 'ie=utf-8&kw=' + encodeURIComponent(name) + '&tbs=' + encodeURIComponent(tbs);
    try {
      const r = await fetch('https://tieba.baidu.com/sign/add', { method: 'POST', headers: { 'Cookie': cookie, 'User-Agent': UA, 'Referer': 'https://tieba.baidu.com/', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
      const j = await r.json();
      const no = j && j.no;
      if (no === 0) { success++; details.push('✓ ' + name); }
      else if (no === 1101 || no === 110021) { already++; details.push('· ' + name + '（今日已签）'); }
      else if (no === 2150040) { needCaptcha.push(name); details.push('⚠ ' + name + '（需验证码）'); }
      else if (no === 1011) { skipped.push(name); details.push('· ' + name + '（未加入/等级不足，跳过）'); }
      else { failed.push(name); details.push('✗ ' + name + '（' + ((j && (j.error || j.msg)) || no) + '）'); }
    } catch (e) { failed.push(name); details.push('✗ ' + name + '（请求异常）'); }
    if (i < forums.length - 1) await ckSleep(400);
  }
  const total = forums.length;
  const signedOk = (failed.length === 0 && needCaptcha.length === 0 && (success + already + skipped.length) > 0);
  let reason;
  if (signedOk) reason = '一键签到完成：新签 ' + success + ' 个，今日已签 ' + already + ' 个，跳过 ' + skipped.length + ' 个，共 ' + total + ' 个吧。';
  else reason = '一键签到未完全成功：新签 ' + success + '，已签 ' + already + '，需验证码 ' + needCaptcha.length + ' 个，跳过 ' + skipped.length + ' 个，失败 ' + failed.length + ' 个。';
  return { ok: signedOk, status: 200, reason, details, snippet: details.slice(0, 40).join(' | ') };
}

function ckSiteDoneToday(id) { const l = ck.siteLogs[id]; return !!(l && l[ckDs()]); }
function ckMarkDone(id) { const l = ck.siteLogs[id] || {}; l[ckDs()] = Date.now(); ck.siteLogs[id] = l; }
function ckSlotDone(id, date, slot) { const d = ck.scheduleLog && ck.scheduleLog[date]; return !!(d && d[id] && d[id].indexOf(slot) >= 0); }
function ckPruneScheduleLog(today) { const sl = ck.scheduleLog; if (!sl) return; for (const dt in sl) if (dt < today) delete sl[dt]; }
function ckMarkSlot(id, date, slot) { ck.scheduleLog = ck.scheduleLog || {}; const d = ck.scheduleLog[date] || (ck.scheduleLog[date] = {}); const arr = d[id] || (d[id] = []); if (arr.indexOf(slot) < 0) arr.push(slot); ckPruneScheduleLog(date); ckSave(); }
function ckBump() { ck.meta.additionsSinceBackup = (ck.meta.additionsSinceBackup || 0) + 1; ckSave(); }
function ckLog(id, res) { const s = ck.sites.find(x => x.id === id); if (!s) return; s.lastResult = res; s.lastRun = ckDs(); if (res.ok) ckMarkDone(id); ckSave(); }
async function ckCheckinSite(id) { const s = ck.sites.find(x => x.id === id); if (!s) return { ok: false, reason: '站点不存在' }; const res = await ckRun(s); ckLog(id, res); return res; }
async function ckCheckinAll() { const targets = ck.sites.filter(s => s.enabled && !ckSiteDoneToday(s.id)); const out = { ok: 0, fail: 0, list: [] }; for (const s of targets) { const res = await ckRun(s); ckLog(s.id, res); if (res.ok) out.ok++; else out.fail++; out.list.push({ name: s.name, ok: res.ok, reason: res.reason || ('HTTP ' + res.status) }); await new Promise(r => setTimeout(r, 600)); } return out; }
async function ckCheckinAutoDaily() { const targets = ck.sites.filter(s => s.enabled && !s.schedule && !ckSiteDoneToday(s.id)); const out = { ok: 0, fail: 0, list: [] }; for (const s of targets) { const res = await ckRun(s); ckLog(s.id, res); if (res.ok) out.ok++; else out.fail++; out.list.push({ name: s.name, ok: res.ok, reason: res.reason || ('HTTP ' + res.status) }); await new Promise(r => setTimeout(r, 600)); } return out; }
function ckDaily() { const t = ckDs(); if (ck.daily[t]) { delete ck.daily[t]; ckSave(); return { ok: true, undone: true }; } ck.daily[t] = Date.now(); ckBump(); ckSave(); return { ok: true, done: true }; }

let ckLastAutoRun = '';
let ckAutoRunning = false;
function ckTick() {
  const today = ckDs(), hm = ckNowHM();
  if (!ck.settings.autoRun) return;
  const autoTime = ck.settings.autoDaily || '09:00';
  if (hm >= autoTime && ckLastAutoRun !== today && !ckAutoRunning) { ckLastAutoRun = today; ckAutoRunning = true; ckCheckinAutoDaily().finally(() => { ckAutoRunning = false; }); }
  for (const s of ck.sites) {
    if (!s.enabled || !s.schedule) continue;
    const slots = ckToSlots(s.schedule);
    for (const slot of slots) { if (hm >= slot && !ckSlotDone(s.id, today, slot)) { ckMarkSlot(s.id, today, slot); ckCheckinSite(s.id); } }
  }
}
function startCheckinScheduler() { ckLoad(); setInterval(ckTick, 30000); setInterval(ckSave, 60000); console.log('[checkin] scheduler started (30s, auto=' + ck.settings.autoRun + ')'); }

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

// 按记录日期查找当月加班费率：优先 monthlyRates[YYYY-MM]，没有则沿用上月，都没有用 hourlyRate
function getMonthlyRate(dateStr) {
  if (!dateStr) return db.settings.hourlyRate || 0;
  const m = String(dateStr).slice(0, 7); // "2026-08"
  const rates = (db.settings && db.settings.monthlyRates) ? db.settings.monthlyRates : {};
  if (rates[m] !== undefined && rates[m] !== null) return Number(rates[m]) || 0;
  // 没设定当月 → 向前找最近一个月的费率
  const keys = Object.keys(rates).filter((k) => k < m).sort().reverse();
  if (keys.length > 0) return Number(rates[keys[0]]) || 0;
  // 兜底
  return db.settings.hourlyRate || 0;
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

// 构建下载镜像候选：GitHub 直连 + ghproxy 加速，哪个通走哪个
function mirrorCandidates(url) {
  if (!url) return [];
  const proxied = 'https://ghproxy.net/' + url;
  if (url.indexOf('ghproxy.net') >= 0) {
    // 已是镜像地址 -> 兜底回退到直连
    return [url, url.replace('https://ghproxy.net/', '')];
  }
  return [url, proxied];
}

// 检查 GitHub 上的最新版本（对齐 fnos-hermes-agent 的「更新页自动拉取版本对比」）
// 优先读 fnpack.json（第三方源索引，无 API 限流），失败再退回 GitHub Releases API
async function checkUpdate() {
  const current = APP_VERSION;
  const REPO = 'bubujun1/overtime-tracker';
  // NAS 网络实测：raw.githubusercontent 与 api.github.com 可达；jsdelivr/ghproxy 不稳定或被拦截。
  // 故优先走 NAS 可达源，镜像仅作最后兜底，避免每次「检查更新」先空等两个 8s 超时。
  const sources = [
    { url: 'https://raw.githubusercontent.com/' + REPO + '/main/fnpack.json', type: 'fnpack' },
    { url: 'https://api.github.com/repos/' + REPO + '/releases/latest', type: 'github' },
    { url: 'https://ghproxy.net/https://raw.githubusercontent.com/' + REPO + '/main/fnpack.json', type: 'fnpack' },
    { url: 'https://cdn.jsdelivr.net/gh/' + REPO + '@main/fnpack.json', type: 'fnpack' }
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

// 解析 fnOS 官方安装命令 appcenter-cli（记加班在 fnOS 以高权限运行，可直接用它安装/升级自身）
function resolveInstallCmd() {
  const abs = ['/usr/bin/appcenter-cli', '/usr/local/bin/appcenter-cli', '/bin/appcenter-cli', '/sbin/appcenter-cli'];
  for (const p of abs) {
    try { if (fs.existsSync(p)) return { bin: p, sudo: false }; } catch (e) {}
  }
  try {
    const p = execSync('command -v appcenter-cli 2>/dev/null', { encoding: 'utf8' }).trim();
    if (p) return { bin: p, sudo: false };
  } catch (e) {}
  try {
    const sudo = execSync('command -v sudo 2>/dev/null', { encoding: 'utf8' }).trim();
    if (sudo) return { bin: sudo, sudo: true };
  } catch (e) {}
  return null;
}

// 异步触发安装（detached，安装过程独立于本服务，即使本服务被重启也不影响）
function runInstall(cmd, fpkPath) {
  const args = cmd.sudo ? ['-n', 'appcenter-cli', 'install-fpk', fpkPath] : ['install-fpk', fpkPath];
  const logPath = path.join(VAR_DIR, 'updates', 'install.log');
  let log = null;
  try { log = fs.createWriteStream(logPath, { flags: 'a' }); } catch (e) {}
  const w = (s) => { if (log) try { log.write(s); } catch (e) {} };
  w('\n=== install @ ' + new Date().toISOString() + ' ===\n');
  w('bin=' + cmd.bin + ' sudo=' + cmd.sudo + ' args=' + JSON.stringify(args) + '\n');
  try {
    const child = spawn(cmd.bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.stdout) child.stdout.on('data', (d) => w('[out] ' + d));
    if (child.stderr) child.stderr.on('data', (d) => w('[err] ' + d));
    child.on('error', (e) => w('spawn error: ' + e.message + '\n'));
    child.on('exit', (code, sig) => { w('exit code=' + code + ' signal=' + sig + '\n'); if (log) log.end(); });
    child.unref();
  } catch (e) {
    w('exception: ' + e.message + '\n');
    if (log) log.end();
  }
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

  // 一键更新：下载新版本 .fpk，并用 fnOS 官方 appcenter-cli 直接覆盖安装（真·自动更新）
  if (head === 'update' && method === 'POST') {
    try {
      const info = await checkUpdate();
      if (!info.ok) return sendJSON(res, 200, { ok: false, error: info.error, phase: 'check' });
      if (!info.hasUpdate) return sendJSON(res, 200, { ok: false, error: '当前已是最新版本 v' + info.current, phase: 'check' });
      if (!info.downloadUrl) return sendJSON(res, 200, { ok: false, error: '未获取到下载地址', phase: 'check' });

      const updateDir = path.join(VAR_DIR, 'updates');
      fs.mkdirSync(updateDir, { recursive: true });
      const fpkPath = path.join(updateDir, 'overtime-tracker-' + info.latest + '.fpk');

      const candidates = mirrorCandidates(info.downloadUrl);
      console.log('[update] download candidates:', candidates);
      let buf = null, usedUrl = null, lastErr = null;
      for (const cand of candidates) {
        try {
          const dlCtrl = new AbortController();
          const dlTimer = setTimeout(() => dlCtrl.abort(), 120000); // 2 分钟超时
          const dlRes = await fetch(cand, {
            signal: dlCtrl.signal,
            headers: { 'User-Agent': 'overtime-tracker-updater' }
          });
          clearTimeout(dlTimer);
          if (!dlRes.ok || !dlRes.body) { lastErr = 'HTTP ' + dlRes.status; continue; }
          buf = Buffer.from(await dlRes.arrayBuffer());
          usedUrl = cand;
          break;
        } catch (e) { lastErr = e.message; }
      }
      if (!buf) {
        return sendJSON(res, 200, { ok: false, error: '下载失败（已尝试直连与 ghproxy 镜像）：' + (lastErr || '未知'), phase: 'download' });
      }

      fs.writeFileSync(fpkPath, buf);
      console.log('[update] downloaded via', usedUrl, buf.length, 'bytes ->', fpkPath);

      // 解析 fnOS 安装命令（appcenter-cli install-fpk <path>）
      const cmd = resolveInstallCmd();
      if (!cmd) {
        // 系统无安装命令：仅完成下载，交前端提供「下载安装包」按钮（HTTP 流式下载绕过管理员目录限制）
        return sendJSON(res, 200, {
          ok: true,
          phase: 'download-only',
          version: info.latest,
          fpkPath: fpkPath,
          fpkSize: buf.length,
          message: '已下载，但系统安装命令不可用，请点击下方按钮下载安装包后到飞牛应用中心手动覆盖'
        });
      }

      // 先回包，再延迟触发安装，确保本次响应送达（安装会重启本服务）
      const resp = {
        ok: true,
        phase: 'installing',
        version: info.latest,
        fpkPath: fpkPath,
        fpkSize: buf.length,
        install: { bin: cmd.bin, sudo: cmd.sudo },
        message: '已触发覆盖安装，应用将自动重启更新'
      };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(resp));
      setTimeout(() => { runInstall(cmd, fpkPath); }, 600);
      return;
    } catch (e) {
      return sendJSON(res, 200, { ok: false, error: '更新失败: ' + e.message, phase: 'unknown' });
    }
  }

  // 下载已缓存的 fpk 到浏览器（绕过飞牛文件选择器无法访问管理员目录的限制，作为自动安装失败时的兜底）
  if (head === 'update-download' && method === 'GET') {
    try {
      const ver = parts[1] || null; // 形如 /api/update-download/1.1.2
      let fpkPath = ver ? path.join(VAR_DIR, 'updates', 'overtime-tracker-' + ver + '.fpk') : null;
      if (!fpkPath || !fs.existsSync(fpkPath)) {
        const dir = path.join(VAR_DIR, 'updates');
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => String(f).toLowerCase().endsWith('.fpk')).sort();
          if (files.length) fpkPath = path.join(dir, files[files.length - 1]);
        }
      }
      if (!fpkPath || !fs.existsSync(fpkPath)) {
        return sendJSON(res, 404, { ok: false, error: '未找到已下载的安装包，请先点「立即更新覆盖」下载' });
      }
      const stat = fs.statSync(fpkPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(fpkPath) + '"');
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(fpkPath).pipe(res);
      return;
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  if (head === 'state' && method === 'GET') {
    const enriched = db.records.map((r) => ({ ...r, subtotal: recordSubtotal(r, getMonthlyRate(r.date)) }));
    return sendJSON(res, 200, { settings: db.settings, records: enriched });
  }

  if (head === 'summary' && method === 'GET') {
    let totalHours = 0, totalCost = 0;
    for (const r of db.records) {
      totalHours += Number(r.hours) || 0;
      totalCost += recordSubtotal(r, getMonthlyRate(r.date));
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
    // 月度加班费率（按 "YYYY-MM": rate 格式存储）
    if (patch.monthlyRates && typeof patch.monthlyRates === 'object') {
      if (!db.settings.monthlyRates) db.settings.monthlyRates = {};
      const keys = Object.keys(patch.monthlyRates);
      for (const k of keys) {
        // 只接受 YYYY-MM 格式的 key
        if (/^\d{4}-\d{2}$/.test(k)) {
          const v = Number(patch.monthlyRates[k]);
          if (!isNaN(v) && v >= 0) db.settings.monthlyRates[k] = round2(v);
          else delete db.settings.monthlyRates[k]; // 设为 null/undefined 则删除
        }
      }
    }
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
      const enriched = db.records.map((r) => ({ ...r, subtotal: recordSubtotal(r, getMonthlyRate(r.date)) }));
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
      return sendJSON(res, 201, { ...rec, subtotal: recordSubtotal(rec, getMonthlyRate(rec.date)) });
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
      return sendJSON(res, 200, { ...rec, subtotal: recordSubtotal(rec, getMonthlyRate(rec.date)) });
    }
  }

  // ====== 备份管理 API ======

  // GET /api/backups — 列出最近备份
  if (head === 'backups' && method === 'GET') {
    try {
      const list = [];
      if (fs.existsSync(BACKUP_DIR)) {
        const files = fs.readdirSync(BACKUP_DIR)
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort()
          .reverse();
        for (const f of files) {
          const fp = path.join(BACKUP_DIR, f);
          try {
            const stat = fs.statSync(fp);
            list.push({ name: f, size: stat.size, time: stat.mtime.toISOString(), date: f.replace('.json', '') });
          } catch (e) { /* skip */ }
        }
      }
      return sendJSON(res, 200, { ok: true, backups: list, keep: BACKUP_KEEP_DAYS });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // POST /api/backup — 手动触发一次备份
  if (head === 'backup' && method === 'POST') {
    try {
      runBackup();
      return sendJSON(res, 200, { ok: true, message: '备份完成' });
    } catch (e) {
      return sendJSON(res, 500, { error: '备份失败: ' + e.message });
    }
  }

  // GET /api/backup/:file — 下载指定备份文件
  if (head === 'backup' && method === 'GET' && parts[1]) {
    try {
      const fname = parts[1];
      // 安全检查：只允许日期命名的 JSON 文件
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fname)) {
        return sendJSON(res, 400, { error: '无效的文件名' });
      }
      const fp = path.join(BACKUP_DIR, fname);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: '备份文件不存在' });
      const stat = fs.statSync(fp);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="overtime-backup-' + fname);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(fp).pipe(res);
      return;
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // POST /api/backup/:file/restore — 从备份恢复
  if (head === 'backup' && method === 'POST' && parts[1] && parts[2] === 'restore') {
    try {
      const fname = parts[1];
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fname)) {
        return sendJSON(res, 400, { error: '无效的文件名' });
      }
      const fp = path.join(BACKUP_DIR, fname);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: '备份文件不存在' });
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!data || !Array.isArray(data.records)) {
        return sendJSON(res, 400, { error: '备份文件格式无效' });
      }
      db = data;
      if (!db.settings) db.settings = JSON.parse(JSON.stringify(DEFAULT_DB.settings));
      saveDB();
      return sendJSON(res, 200, { ok: true, message: '已恢复到 ' + fname + ', 共 ' + db.records.length + ' 条记录', records: db.records.length });
    } catch (e) {
      return sendJSON(res, 500, { error: '恢复失败: ' + e.message });
    }
  }

  // ====== 签到模块 API（命名空间 /api/checkin）======
  if (head === 'checkin') {
    const sub = parts.slice(1);
    const sp = sub[0] || '';
    if (sp === 'state' && method === 'GET') {
      const pub = Object.assign({}, ck, { _localOnly: true });
      return sendJSON(res, 200, { state: pub, templates: ckTemplates });
    }
    if (sp === 'export' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="checkin-backup-' + ckDs() + '.json"' });
      res.end(JSON.stringify({ app: 'overtime-checkin', version: 2, exportedAt: Date.now(), state: ck }, null, 2)); return;
    }
    if (sp === 'all' && method === 'POST') { const out = await ckCheckinAll(); return sendJSON(res, 200, out); }
    if (sp === 'daily' && method === 'POST') { return sendJSON(res, 200, ckDaily()); }
    if (sp === 'load-demo' && method === 'POST') { ckDemoSites().forEach(s => ck.sites.push(s)); ck.meta.cleared = false; ckBump(); ckSave(); return sendJSON(res, 200, { ok: true }); }
    if (sp === 'clear' && method === 'POST') { ck = ckDefaultState(); ck.meta.cleared = true; ckSave(); return sendJSON(res, 200, { ok: true }); }
    if (sp === 'site') {
      if (method === 'DELETE') {
        const id = parts[2];
        ck.sites = ck.sites.filter(x => x.id !== id); delete ck.siteLogs[id]; ckSave(); return sendJSON(res, 200, { ok: true });
      }
      if (method === 'POST') {
        let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
        if (b.id) {
          const s = ck.sites.find(x => x.id === b.id);
          if (s) {
            const keep = s.req || {};
            const incomingReq = (b.req && typeof b.req === 'object') ? b.req : {};
            const preserved = {};
            ['type', 'success', 'token', 'csrf', 'getUrl', 'keyword'].forEach(function (k) { if (keep[k] !== undefined && incomingReq[k] === undefined) preserved[k] = keep[k]; });
            b.req = Object.assign({}, incomingReq, preserved);
            Object.assign(s, b);
          }
        } else { const ns = Object.assign({ id: ckUid(), demo: false, enabled: true, cookie: '', req: {}, tpl: null, schedule: null, emoji: '', group: '' }, b); ck.sites.push(ns); }
        ckBump(); ckSave(); return sendJSON(res, 200, { ok: true, id: b.id || ck.sites[ck.sites.length - 1].id });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
    if (sp === 'settings' && method === 'POST') {
      let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      ck.settings = Object.assign({}, ck.settings, b.settings || {});
      if (b.meta) ck.meta = Object.assign({}, ck.meta, b.meta);
      ckSave(); return sendJSON(res, 200, { ok: true });
    }
    if (sp === 'import' && method === 'POST') {
      let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      const incoming = b.state || b;
      let ns; try { ns = ckNormalize(incoming); } catch (e) { return sendJSON(res, 400, { ok: false, reason: '格式不正确' }); }
      const mode = b.mode || 'overwrite';
      if (mode === 'merge') {
        const byId = {}; ck.sites.forEach(s => byId[s.id] = s);
        ns.sites.forEach(s => { if (!byId[s.id]) ck.sites.push(s); });
        for (const sid in ns.siteLogs) { const cur = ck.siteLogs[sid] || {}; for (const dt in ns.siteLogs[sid]) if (!cur[dt] || ns.siteLogs[sid][dt] < cur[dt]) cur[dt] = ns.siteLogs[sid][dt]; ck.siteLogs[sid] = cur; }
        for (const d in ns.daily) if (!ck.daily[d] || ns.daily[d] < ck.daily[d]) ck.daily[d] = ns.daily[d];
      } else { ck.sites = ns.sites; ck.siteLogs = ns.siteLogs; ck.daily = ns.daily; ck.settings = ns.settings; ck.meta = ns.meta; }
      ck.meta.cleared = false; ckSave(); return sendJSON(res, 200, { ok: true });
    }
    if (sp === 'test' && method === 'POST') {
      let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      const r2 = await ckRun({ id: b.id || 'test', name: b.name || '测试', cookie: b.cookie || '', req: b.req || {} });
      return sendJSON(res, 200, r2);
    }
    if (method === 'POST' && sp && !['state', 'export', 'all', 'daily', 'load-demo', 'clear', 'site', 'settings', 'import', 'test'].includes(sp)) {
      const r = await ckCheckinSite(sp);
      return sendJSON(res, 200, r);
    }
    return sendJSON(res, 404, { error: 'unknown checkin endpoint' });
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

/* ====== 自动备份（每日 06:00，数据变化时才备份，保留最近 3 份）====== */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_DAYS = 3;

function dateStamp(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function pad2(n) { return String(n).length < 2 ? '0' + String(n) : String(n); }

// 计算数据哈希（用于判断是否需要备份）
function dataHash() {
  try {
    const s = JSON.stringify({ settings: db.settings, records: db.records });
    return crypto.createHash('md5').update(s).digest('hex').slice(0, 16);
  } catch (e) { return ''; }
}
let lastBackupHash = '';

function runBackup(force) {
  try {
    // 数据没变且非强制 → 跳过
    const hash = dataHash();
    if (!force && hash && hash === lastBackupHash) {
      console.log('[backup] skipped — data unchanged');
      return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = dateStamp(new Date());
    const dest = path.join(BACKUP_DIR, stamp + '.json');
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, dest);
    }
    lastBackupHash = hash;
    cleanupBackups();
    console.log('[backup] done ' + stamp + (force ? ' (manual)' : ''));
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
  // 计算到下一个凌晨 06:00 的毫秒数
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 5, 0);
  let delay = next.getTime() - now.getTime();
  if (delay < 0) delay += 24 * 3600 * 1000; // 已过今天6点 → 明天6点
  setTimeout(function tick() {
    runBackup(false); // 非强制，数据没变则跳过
    // 每 24 小时执行一次
    setTimeout(tick, 24 * 3600 * 1000);
  }, delay);
  console.log('[backup] scheduled at 06:00, first run in ' + Math.round(delay / 1000) + 's');
}

function start() {
  scheduleDailyBackup();
  startCheckinScheduler();
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
