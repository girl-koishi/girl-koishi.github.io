/**
 * 阶序智调 — 后端实时数据服务器 v3.0
 * ===========================================
 * 静态服务 + WebSocket + REST API + SSE 推送
 * - 静态文件: http://localhost:3080
 * - WS 实时:  ws://localhost:3080 (传统)
 * - API 电价: GET /api/pricing (多源真实电价)
 * - API 全量: GET /api/system-data (时间感知48点数据)
 * - SSE 推送: GET /api/events (实时数据流)
 *
 * 启动: node server.js
 * 访问: http://localhost:3080
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// 优化算法引擎
const algo = require('./algorithm-engine');

const PORT = 3080;

// ===========================================================================
// 认证系统
// ===========================================================================
const ADMIN_CREDENTIALS = [
  { username: 'admin', password: 'jxzd2026', role: '超级管理员', displayName: '系统管理员' },
];

// 有效 token 集合（纯内存，浏览器关闭即失效）
const validTokens = new Map(); // token -> { username, role, displayName, createdAt }

// Token 有效期：8 小时
const TOKEN_TTL = 8 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 从请求中提取 token（Authorization header 或 cookie）
function extractToken(req) {
  // 1. Authorization: Bearer xxx
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 2. Cookie: jxzd_auth_token=xxx
  const cookie = req.headers['cookie'];
  if (cookie) {
    const match = cookie.match(/jxzd_auth_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

// 验证 token 是否有效
function validateToken(token) {
  if (!token) return null;
  const session = validTokens.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > TOKEN_TTL) {
    validTokens.delete(token);
    return null;
  }
  return session;
}

// 解析请求体（JSON）
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// 不需要认证的路径白名单
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/auth.js',
  '/api/login',
  '/api/auth-check',
  '/api/logout',
]);

function isPublicPath(pathname) {
  // 登录页、auth.js、登录相关 API 不需要认证
  if (PUBLIC_PATHS.has(pathname)) return true;
  // 静态资源（CSS/JS/图片/字体）允许公开访问
  const ext = path.extname(pathname).toLowerCase();
  if (['.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'].includes(ext)) {
    return true;
  }
  return false;
}

// ===========================================================================
// 系统状态模拟（BASE 为不可变快照）
// ===========================================================================

const BASE = {
  ts: Date.now(),
  outdoorTemp: 31.9,
  grid: {
    frequency: 50.02,
    voltage: 220.5,
    capacity: 3500,
    totalLoad: 3030,
    loadRate: 86.6,
    alerts: 3,
    responseRate: 78.6,
    strategyRate: 92.5,
  },
  commercial: {
    name: '万达商场',
    currentTemp: 22.9,
    targetTemp: 24.0,
    currentPower: 1595,
    peakPower: 1800,
    loadRate: 88.6,
    cop: 5.82,
    dailyKwh: 28547,
  },
  residential: {
    name: '幸福小区',
    currentTemp: 26.7,
    targetTemp: 26.0,
    currentPower: 1435,
    peakPower: 1520,
    loadRate: 94.4,
    avgPerHouse: 1.86,
    totalHouses: 2560,
    comfort: 86.5,
  },
  generation: {
    fire: 526,
    wind: 147,
    solar: 48,
    storage: 36,
    total: 757,
    efficiency: 89.2,
    frequency: 50.02,
    voltage: 10.52,
    pf: 0.958,
  },
  cooling: {
    comLoad: [120, 115, 110, 108, 145, 210, 260, 280, 275, 240, 200, 160],
    resLoad: [85, 75, 68, 65, 95, 130, 145, 155, 160, 175, 155, 120],
    total: [205, 190, 178, 173, 240, 340, 405, 435, 435, 415, 355, 280],
  },
  strategies: {
    preCool: { saved: 324, pct: 82 },
    zoneControl: { saved: 286, pct: 72 },
    nightStorage: { saved: 412, pct: 90 },
    peakShift: { saved: 198, pct: 50 },
    totalSaved: 1856,
    adjustable: 1248,
    responded: 980,
  },
  recovery: {
    supplyRate: 96.8,
    loadRate: 95.8,
    commercialRate: 98.7,
    residentialRate: 99.2,
  },
  ranking: [
    { name: '万达商场', kw: 395, trend: 'up' },
    { name: '工业用户', kw: 380, trend: 'up' },
    { name: '幸福小区', kw: 310, trend: 'down' },
    { name: '数据中心', kw: 286, trend: 'up' },
    { name: '人民医院', kw: 245, trend: 'down' },
    { name: '行政中心', kw: 198, trend: 'down' },
    { name: '商业街', kw: 165, trend: 'up' },
  ],
  alerts: [
    { l: 'c', time: '19:32:05', msg: '110kV 线路 1A 保护动作', tag: '严重' },
    { l: 'c', time: '19:28:11', msg: '商业综合体A 负荷超限 12%', tag: '严重' },
    { l: 'w', time: '19:25:47', msg: '变压器T2 温度异常 82°C', tag: '告警' },
    { l: 'w', time: '19:22:30', msg: '智能终端03 通信延迟', tag: '告警' },
    { l: 'i', time: '19:18:55', msg: '预冷控制策略已下发', tag: '信息' },
    { l: 'i', time: '19:15:00', msg: '幸福小区负荷稳定', tag: '信息' },
  ],
  topology: {
    mainBus: '220kV',
    feeders: [
      { id: 'feeder1', name: '商业A区', load: 395, voltage: '10kV', status: 'normal' },
      { id: 'feeder2', name: '居民A区', load: 310, voltage: '10kV', status: 'warning' },
      { id: 'feeder3', name: '工业区', load: 380, voltage: '10kV', status: 'normal' },
      { id: 'feeder4', name: '商业B区', load: 165, voltage: '10kV', status: 'normal' },
      { id: 'feeder5', name: '数据中心', load: 286, voltage: '10kV', status: 'normal' },
      { id: 'feeder6', name: '医院', load: 245, voltage: '10kV', status: 'normal' },
    ],
    transformers: [
      { id: 'T1', voltage: '220/110kV', load: 68, temp: 42, status: 'normal' },
      { id: 'T2', voltage: '220/110kV', load: 72, temp: 45, status: 'warning' },
    ],
  },
};

// 设备单元模板（用于每次深拷贝重建）
const AC_UNITS_TPL = [
  { name: '1# 离心机组', status: 'run', power: 245, loadRate: 72 },
  { name: '2# 离心机组', status: 'run', power: 218, loadRate: 64 },
  { name: '3# 螺杆机组', status: 'idle', power: 95, loadRate: 32 },
  { name: '4# 螺杆机组', status: 'off', power: 0, loadRate: 0 },
];

const GEN_UNITS_TPL = [
  { name: '1# 火电机组', status: 'run', power: 186, loadRate: 78 },
  { name: '2# 火电机组', status: 'run', power: 168, loadRate: 70 },
  { name: '3# 火电机组', status: 'run', power: 172, loadRate: 72 },
  { name: '4# 火电机组', status: 'stby', power: 0, loadRate: 0 },
  { name: '5# 风电机组', status: 'run', power: 82, loadRate: 55 },
  { name: '6# 风电机组', status: 'run', power: 65, loadRate: 43 },
  { name: '7# 光伏阵列', status: 'run', power: 48, loadRate: 60 },
  { name: '8# 储能系统', status: 'run', power: 36, loadRate: 72 },
];

// 24h趋势数据生成
function genTrendData(length, base, amp, phase) {
  const now = Date.now();
  return Array.from({ length }, (_, i) => {
    const t = now - (length - 1 - i) * 1800000; // 30min intervals
    const h = (i / 2) % 24;
    return [t, Math.round((base + amp * Math.sin((h - 8) / 24 * 2 * Math.PI + phase) + (Math.random() - 0.5) * 4) * 10) / 10];
  });
}

// ===========================================================================
// 波动模拟工具
// ===========================================================================
function rw(val, range) {
  return val + (Math.random() - 0.5) * range;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// 对 currentState 进行深拷贝（每次 tick 前调用，避免引用污染）
function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// 重建设备单元列表（每次 tick 从模板重新生成，避免模块级变量被污染）
function makeAcUnits() {
  return JSON.parse(JSON.stringify(AC_UNITS_TPL));
}
function makeGenUnits() {
  return JSON.parse(JSON.stringify(GEN_UNITS_TPL));
}

// tick：接收旧状态，返回新状态（纯函数，不修改输入）
function tick(oldState) {
  const s = cloneState(oldState); // 深拷贝，不修改原对象

  s.grid.totalLoad = clamp(rw(s.grid.totalLoad, 40), 2800, 3200);
  s.grid.loadRate = Math.round(s.grid.totalLoad / s.grid.capacity * 1000) / 10;
  s.grid.frequency = clamp(rw(s.grid.frequency, 0.02), 49.95, 50.05);
  s.grid.responseRate = clamp(rw(s.grid.responseRate, 1), 74, 82);

  s.commercial.currentTemp = clamp(rw(s.commercial.currentTemp, 0.06), 22, 27);
  s.commercial.currentPower = clamp(rw(s.commercial.currentPower, 12), 1200, 1800);
  s.commercial.loadRate = Math.round(s.commercial.currentPower / s.commercial.peakPower * 1000) / 10;
  s.commercial.cop = clamp(rw(s.commercial.cop, 0.05), 4.5, 7);
  s.commercial.dailyKwh += Math.round(s.commercial.currentPower * 0.001 * 3);

  s.residential.currentTemp = clamp(rw(s.residential.currentTemp, 0.05), 24, 28);
  s.residential.currentPower = clamp(rw(s.residential.currentPower, 15), 800, 1550);
  s.residential.loadRate = Math.round(s.residential.currentPower / s.residential.peakPower * 1000) / 10;
  s.residential.comfort = clamp(rw(s.residential.comfort, 0.5), 72, 95);
  s.residential.avgPerHouse = Math.round(s.residential.currentPower / s.residential.totalHouses * 100) / 100;

  s.generation.fire = clamp(rw(s.generation.fire, 8), 450, 580);
  s.generation.wind = clamp(rw(s.generation.wind, 5), 80, 180);
  s.generation.solar = clamp(rw(s.generation.solar, 2), 10, 65);
  s.generation.storage = clamp(rw(s.generation.storage, 2), 15, 50);
  s.generation.total = Math.round(s.generation.fire + s.generation.wind + s.generation.solar + s.generation.storage);
  s.generation.efficiency = clamp(rw(s.generation.efficiency, 0.3), 86, 94);

  s.strategies.adjustable = clamp(rw(s.strategies.adjustable, 20), 1100, 1400);
  s.strategies.responded = Math.round(s.strategies.adjustable * s.grid.responseRate / 100);

  s.recovery.supplyRate = clamp(rw(s.recovery.supplyRate, 0.3), 94, 99);
  s.recovery.loadRate = clamp(rw(s.recovery.loadRate, 0.3), 93, 98);

  // Ranking
  s.ranking.forEach(r => {
    r.kw = clamp(rw(r.kw, 3), 100, 450);
  });

  // Topology feeders
  s.topology.feeders.forEach(f => {
    f.load = clamp(rw(f.load, 5), 120, 420);
    if (Math.random() < 0.02) f.status = f.status === 'normal' ? 'warning' : 'normal';
  });
  s.topology.transformers.forEach(t => {
    t.load = clamp(rw(t.load, 2), 60, 80);
    t.temp = clamp(rw(t.temp, 1), 38, 52);
  });

  s.ts = Date.now();
  return s;
}

// 处理前端指令（真正改变状态，而不仅仅是 ack）
function handleCommand(action, payload, state) {
  const s = cloneState(state);

  switch (action) {
    case 'setTargetTemp':
      // payload: { area: 'commercial'|'residential', temp: number }
      if (payload.area === 'commercial') {
        s.commercial.targetTemp = payload.temp;
      } else if (payload.area === 'residential') {
        s.residential.targetTemp = payload.temp;
      }
      break;

    case 'setAcUnit':
      // payload: { index: number, status: 'run'|'idle'|'off' }
      // 注意：AC units 由前端在 payload 中提供，服务端只记录
      break;

    case 'triggerFault':
      // 模拟故障：降低发电功率，提高负荷
      s.generation.total = Math.round(s.generation.total * 0.6);
      s.generation.fire = Math.round(s.generation.fire * 0.5);
      s.grid.totalLoad = Math.round(s.grid.totalLoad * 1.1);
      s.grid.loadRate = Math.round(s.grid.totalLoad / s.grid.capacity * 1000) / 10;
      s.grid.alerts += 1;
      s.alerts.unshift({
        l: 'c',
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        msg: '模拟故障触发：发电功率下降 40%',
        tag: '严重',
      });
      break;

    case 'clearFault':
      // 恢复正常
      s.generation.fire = BASE.generation.fire;
      s.generation.total = BASE.generation.total;
      s.grid.totalLoad = BASE.grid.totalLoad;
      s.grid.loadRate = BASE.grid.loadRate;
      s.alerts.unshift({
        l: 'i',
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        msg: '故障已清除，系统恢复正常',
        tag: '信息',
      });
      break;

    default:
      // 未知指令，返回原状态
      return null;
  }

  s.ts = Date.now();
  return s;
}

// ===========================================================================
// MIME 类型映射
// ===========================================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===========================================================================
// 电价数据引擎（多源真实数据 + 仿真兜底）
// ===========================================================================
let pricingCache = null;
let pricingCacheTime = 0;
let pricingSource = 'simulation';

function fetchLiaoningSpotPrice() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'fgw.ln.gov.cn',
      path: '/fgw/xxgk/xhdj/index.shtml',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 8000,
    };
    const req = https.get(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const dataAttrMatch = body.match(/data-prices=['"]([^'"]+)['"]/);
        if (dataAttrMatch) {
          try { resolve(JSON.parse(dataAttrMatch[1])); return; } catch(e) {}
        }
        reject(new Error('No parseable price data'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function generateSimulatedPricing(now) {
  const hour = now.getHours();
  const month = now.getMonth() + 1;
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  const basePrice = Array.from({ length: 48 }, (_, i) => {
    const h = i / 2;
    let price;
    if (h >= 23 || h < 7) price = 200 + 40 * Math.sin((h - 23) * Math.PI / 8);
    else if (h >= 8 && h < 11) price = 350 + 80 * Math.sin((h - 8) * Math.PI / 3);
    else if (h >= 17 && h < 21) price = 380 + 100 * Math.sin((h - 17) * Math.PI / 4);
    else price = 280 + 60 * Math.sin((h - 11) * Math.PI / 6);

    if (month >= 6 && month <= 8) price *= 1.12;
    else if (month >= 11 || month <= 2) price *= 1.06;
    if (isWeekend) price *= 0.85;

    const dayFactor = 1 + 0.06 * Math.sin(dayOfYear * 2.17) * Math.cos(dayOfYear * 3.41);
    price *= dayFactor;
    return Math.round(price * 100) / 100;
  });

  const realTimePrice = basePrice.map((bp, i) => {
    const h = i / 2;
    let dev;
    if (h >= 17 && h < 21) dev = bp * (0.08 * Math.sin(i * 1.7) + 0.05 * Math.cos(i * 3.1));
    else if (h >= 8 && h < 11) dev = bp * (0.06 * Math.sin(i * 2.3) + 0.03 * Math.cos(i * 2.7));
    else dev = bp * (0.04 * Math.sin(i * 3.1) + 0.02 * Math.cos(i * 4.1));
    return Math.round((bp + dev) * 100) / 100;
  });

  return { date: now.toISOString().split('T')[0], basePrice, realTimePrice, unit: '元/MWh' };
}

async function getRealPricing() {
  const now = Date.now();
  if (pricingCache && (now - pricingCacheTime) < 60000) return pricingCache;

  try {
    const result = await fetchLiaoningSpotPrice();
    pricingSource = 'real';
    pricingCache = { ...result, source: 'real' };
  } catch (e1) {
    pricingSource = 'simulation';
    pricingCache = { ...generateSimulatedPricing(new Date()), source: 'simulation' };
  }
  pricingCacheTime = now;
  pricingCache._fetchedAt = new Date().toISOString();
  pricingCache._source = pricingSource;
  return pricingCache;
}

// ===========================================================================
// 时间感知数据生成
// ===========================================================================
function getCurrentTimeIndex(now) {
  return now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
}

function generateTemperature(tMin, tMax, now) {
  const points = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let t;
    if (h < 14) { const p = (h - 4) / 10; t = tMin + (tMax - tMin) * Math.max(0, Math.sin(Math.min(p, 0.5) * Math.PI)) ** 2; }
    else { const p = (h - 14) / 10; t = tMax - (tMax - tMin) * (1 - Math.cos(Math.min(p, 1) * Math.PI * 0.5)) ** 2; }
    t += 0.3 * Math.sin(i * 7.3 + now.getDate() * 1.7);
    points.push(Math.round(t * 100) / 100);
  }
  return points;
}

function generateHumidity(now) {
  const points = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    const base = 45 + 25 * Math.cos((h - 5) * Math.PI / 12);
    points.push(Math.round(Math.min(100, Math.max(20, base + 3 * Math.sin(i * 5.1 + now.getDate() * 2.3))) * 100) / 100);
  }
  return points;
}

function generateSolarIrradiance(now) {
  const month = now.getMonth() + 1;
  const peak = month >= 5 && month <= 9 ? 950 : 750;
  const points = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    if (h < 6 || h > 18) { points.push(0); continue; }
    const phase = (h - 6) / 12;
    const cloud = 0.7 + 0.3 * Math.abs(Math.cos(now.getDate() * 2.1 + month * 1.4));
    points.push(Math.round(peak * Math.sin(phase * Math.PI) * cloud));
  }
  return points;
}

function generateWindSpeed(now) {
  const base = 4 + 2 * Math.sin(now.getDate() * 1.3);
  const points = [];
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    const d = 1.5 * Math.sin((h - 9) * Math.PI / 12);
    const g = 2 * Math.sin(i * 4.7 + now.getDate() * 3.2) * Math.cos(i * 1.3);
    points.push(Math.round(Math.max(0.5, base + d + g) * 100) / 100);
  }
  return points;
}

function generateCommercialLoad(base, peak, now) {
  const points = [];
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const wf = isWeekend ? 0.72 : 1.0;
  const month = now.getMonth() + 1;
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let l = base;
    if (h >= 8 && h <= 22) {
      if (h >= 11 && h <= 14) l = base + (peak - base) * Math.sin((h - 10) * Math.PI / 4);
      else if (h > 14 && h <= 17) l = base + (peak - base) * 0.7;
      else if (h >= 18 && h <= 21) l = base + (peak - base) * 0.85 * Math.sin((h - 17) * Math.PI / 4);
      else l = base + (peak - base) * 0.5;
    } else l = base * (0.3 + 0.15 * Math.sin((h - 22) * Math.PI / 10));
    if (month >= 6 && month <= 9) l *= 1.2 + 0.1 * Math.sin(i * 1.5);
    l *= wf;
    l += 20 * Math.sin(i * 6.1 + now.getDate() * 2.7);
    points.push(Math.round(l));
  }
  return points;
}

function generateResidentialLoad(base, peak, now) {
  const points = [];
  const month = now.getMonth() + 1;
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    let l;
    if (h >= 6 && h < 8) l = base + (peak - base) * 0.5;
    else if (h >= 8 && h < 12) l = base * 0.6;
    else if (h >= 12 && h < 14) l = base + (peak - base) * 0.3;
    else if (h >= 14 && h < 17) l = base * 0.65;
    else if (h >= 17 && h < 22) { const p = (h - 17) / 5; l = base + (peak - base) * Math.sin(p * Math.PI * 0.7); }
    else l = base * (0.35 + 0.1 * Math.sin((h - 22) * Math.PI / 8));
    if (month >= 6 && month <= 9) l *= 1.15 + 0.08 * Math.sin(i * 1.8);
    l += 15 * Math.sin(i * 5.3 + now.getDate() * 3.1);
    points.push(Math.round(l));
  }
  return points;
}

function generatePVPower(capacity, irradiance, temp) {
  return irradiance.map((irr, i) => {
    if (irr === 0) return 0;
    const tCell = temp[i] + 0.03 * irr;
    const power = capacity * (irr / 1000) * (1 - 0.004 * (tCell - 25));
    return Math.round(Math.max(0, power) * 100) / 100;
  });
}

function generateWindPower(capacity, wind) {
  return wind.map(v => {
    if (v < 3 || v > 25) return 0;
    if (v >= 12) return capacity;
    return Math.round(Math.max(0, capacity * Math.pow((v - 3) / 9, 3)) * 100) / 100;
  });
}

function generateBatterySOC(now) {
  const points = [];
  let soc = 30;
  for (let i = 0; i < 48; i++) {
    const h = i / 2;
    if (h >= 23 || h < 7) soc = Math.min(95, soc + 3.5 * (1 + 0.2 * Math.sin(i * 2.1)));
    else if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) soc = Math.max(10, soc - 2.5 * (1 + 0.15 * Math.cos(i * 3.2)));
    else soc += 0.5 * Math.sin(i * 4.7 + now.getDate() * 1.9);
    points.push(Math.round(soc * 100) / 100);
  }
  return points;
}

function generateSystemData(now) {
  const cti = getCurrentTimeIndex(now);
  const hour = now.getHours();
  const minute = now.getMinutes();
  const month = now.getMonth() + 1;

  const outdoorTemp = generateTemperature(24, 39, now);
  const comIndoor = outdoorTemp.map(t => Math.round((26 + (t > 26 ? (t - 26) * 0.65 : (t - 26) * 0.2)) * 100) / 100);
  const resIndoor = outdoorTemp.map(t => Math.round((26 + (t > 26 ? (t - 26) * 0.55 : (t - 26) * 0.15)) * 100) / 100);
  const humidity = generateHumidity(now);
  const solarIrradiance = generateSolarIrradiance(now);
  const windSpeed = generateWindSpeed(now);

  const comLoad = generateCommercialLoad(800, 1850, now);
  const resLoad = generateResidentialLoad(600, 1550, now);
  const totalLoad = comLoad.map((c, i) => c + resLoad[i]);

  const pvPower = generatePVPower(300, solarIrradiance, outdoorTemp);
  const windPwr = generateWindPower(200, windSpeed);

  const batterySOC = generateBatterySOC(now);

  const timeLabels = Array.from({ length: 48 }, (_, i) =>
    `${String(Math.floor(i/2)).padStart(2,'0')}:${i%2===0?'00':'30'}`);

  const simTime = `${now.getFullYear()}-${String(month).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  return {
    simulationTime: simTime,
    currentTimeIndex: cti,
    timeLabels,
    _timestamp: now.getTime(),
    _realTime: true,
    temperature: {
      outdoor: outdoorTemp,
      commercial: { indoor: comIndoor, current: comIndoor[cti] },
      residential: { indoor: resIndoor, current: resIndoor[cti] },
      current: { outdoor: outdoorTemp[cti], commercial: comIndoor[cti], residential: resIndoor[cti] },
    },
    weather: {
      outdoorTemp, humidity, solarIrradiance, windSpeed,
      current: {
        outdoorTemp: outdoorTemp[cti], humidity: humidity[cti],
        solarIrradiance: solarIrradiance[cti], windSpeed: windSpeed[cti],
        feelsLike: Math.round((outdoorTemp[cti] - 0.4 * (100 - humidity[cti]) / 100 * (outdoorTemp[cti] - 10)) * 100) / 100,
      },
    },
    load: {
      commercial: comLoad, residential: resLoad, total: totalLoad,
      current: { commercial: comLoad[cti], residential: resLoad[cti], total: totalLoad[cti] },
    },
    renewable: {
      pv: { series: pvPower, current: pvPower[cti], capacity: 300 },
      wind: { series: windPwr, current: windPwr[cti], capacity: 200 },
      penetration: { current: Math.round(((pvPower[cti]||0)+(windPwr[cti]||0))/Math.max(totalLoad[cti],1)*10000)/100 },
    },
    battery: {
      soc: { series: batterySOC, current: batterySOC[cti] },
    },
    grid: {
      frequency: Math.round((50 + 0.05 * Math.sin(now.getSeconds()*0.3+minute*0.1)) * 100) / 100,
      voltage: Math.round((10.5 + 0.1 * Math.sin(now.getSeconds()*0.5)) * 100) / 100,
      totalCapacity: 5200,
      loadRate: Math.round(totalLoad[cti] / 5200 * 10000) / 100,
    },
    coolingLoad: {
      total: { current: Math.round(totalLoad[cti] * Math.min(58, 10 + (Math.max(0, outdoorTemp[cti]-26))*3.5) / 100),
        currentRatio: Math.round(Math.min(58, 10 + (Math.max(0, outdoorTemp[cti]-26))*3.5)) },
    },
    energyMix: { thermal: 45, wind: 22, solar: 18, storage: 10, hydro: 5 },
    alerts: generateAlerts(now, cti, outdoorTemp[cti], totalLoad[cti]),
    community: { currentTemp: resIndoor[cti] },
    wanda: { currentTemp: comIndoor[cti], currentPower: comLoad[cti] },
  };
}

function generateAlerts(now, cti, temp, load) {
  const alerts = [
    { title:'电网频率波动', level:'info', value:'50.02 Hz', time:now.toLocaleTimeString() },
    { title:'B区3#馈线重载', level:'warning', value:'87%', time:now.toLocaleTimeString() },
  ];
  if (temp > 35) alerts.unshift({ title:'高温预警', level:'critical', value:temp+'°C', time:now.toLocaleTimeString() });
  if (load > 3000) alerts.unshift({ title:'总负荷超3000kW', level:'critical', value:load+'kW', time:now.toLocaleTimeString() });
  return alerts;
}

// ===========================================================================
// SSE 客户端管理
// ===========================================================================
const sseClients = new Set();

async function broadcastSSE() {
  if (sseClients.size === 0) return;
  const now = new Date();
  const data = generateSystemData(now);
  const pricing = await getRealPricing();
  const cti = data.currentTimeIndex;
  data.pricing = {
    current: pricing.basePrice ? pricing.basePrice[cti] : 350,
    realTime: pricing.realTimePrice ? pricing.realTimePrice[cti] : 360,
    source: pricing._source,
    period: (now.getHours()>=8&&now.getHours()<11)||(now.getHours()>=17&&now.getHours()<21)?'peak':now.getHours()>=23||now.getHours()<7?'valley':'flat',
  };

  // 优化引擎实时评估
  const state = {
    outdoorTemp: data.temperature.current.outdoor,
    gridLoad: data.load.current.total,
    gridLoadRate: data.grid.loadRate,
    coolingLoad: data.coolingLoad.total.current,
    electricityPrice: pricing.realTimePrice ? pricing.realTimePrice[cti] : 350,
    hour: now.getHours(),
  };
  data.optimization = algo.recommendStrategies(state);

  const msg = JSON.stringify({ type: 'data-update', data });
  const dead = [];
  for (const c of sseClients) {
    try { c.write(`data: ${msg}\n\n`); } catch(e) { dead.push(c); }
  }
  for (const c of dead) sseClients.delete(c);
}

// ===========================================================================
// HTTP 服务
// ===========================================================================
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers for API
  if (reqUrl.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  }

  // === 认证 API ===

  // POST /api/login — 管理员登录
  if (reqUrl.pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      const cred = ADMIN_CREDENTIALS.find(c => c.username === username && c.password === password);
      if (!cred) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '账号或密码错误' }));
        return;
      }
      const token = generateToken();
      validTokens.set(token, {
        username: cred.username,
        role: cred.role,
        displayName: cred.displayName,
        createdAt: Date.now(),
      });
      // Cookie 设为 session 级别（不设 Max-Age，浏览器关闭即清除）
      res.setHeader('Set-Cookie', `jxzd_auth_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        token: token,
        username: cred.username,
        role: cred.role,
        displayName: cred.displayName,
        message: '登录成功',
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '请求格式错误' }));
    }
    return;
  }

  // POST /api/logout — 退出登录
  if (reqUrl.pathname === '/api/logout' && (req.method === 'POST' || req.method === 'GET')) {
    const token = extractToken(req);
    if (token) validTokens.delete(token);
    res.setHeader('Set-Cookie', 'jxzd_auth_token=; Path=/; Max-Age=0; HttpOnly');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: '已退出登录' }));
    return;
  }

  // GET /api/auth-check — 验证 token 有效性
  if (reqUrl.pathname === '/api/auth-check' && req.method === 'GET') {
    const token = extractToken(req);
    const session = validateToken(token);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        valid: true,
        username: session.username,
        role: session.role,
        displayName: session.displayName,
      }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, message: 'Token 无效或已过期' }));
    }
    return;
  }

  // === 认证中间件：非公开路径需要验证 token ===
  if (!isPublicPath(reqUrl.pathname)) {
    const token = extractToken(req);
    const session = validateToken(token);
    if (!session) {
      // 如果是 HTML 页面请求，重定向到登录页
      if (reqUrl.pathname.endsWith('.html') || reqUrl.pathname === '/') {
        res.writeHead(302, { 'Location': '/login.html?redirect=' + encodeURIComponent(reqUrl.pathname) });
        res.end();
        return;
      }
      // API 请求返回 401
      if (reqUrl.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权，请先登录', code: 'UNAUTHORIZED' }));
        return;
      }
      // 其他静态资源（.js 等）返回 401
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
  }

  // === API 路由 ===

  // GET /api/state (传统兼容)
  if (reqUrl.pathname === '/api/state') {
    // 每次请求都返回深拷贝，避免引用泄漏
    const acUnits = makeAcUnits();
    const genUnits = makeGenUnits();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...cloneState(currentState),
      acUnits,
      genUnits,
      trendData: {
        total: genTrendData(48, 72, 20, -0.3),
        commercial: genTrendData(48, 65, 18, -0.1),
        residential: genTrendData(48, 55, 22, 0.4),
      },
    }));
    return;
  }

  // GET /api/pricing — 电价数据（真实多源）
  if (reqUrl.pathname === '/api/pricing') {
    try {
      const pricing = await getRealPricing();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pricing));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/system-data — 完整系统数据（时间感知）
  if (reqUrl.pathname === '/api/system-data') {
    try {
      const now = new Date();
      const data = generateSystemData(now);
      const pricing = await getRealPricing();
      const cti = data.currentTimeIndex;
      data.pricing = {
        source: pricing._source || 'simulation',
        date: pricing.date,
        current: pricing.basePrice ? pricing.basePrice[cti] : 350,
        realTime: pricing.realTimePrice ? pricing.realTimePrice[cti] : 360,
        series: pricing.basePrice || [],
        realTimeSeries: pricing.realTimePrice || [],
        unit: '元/MWh',
        period: (now.getHours()>=8&&now.getHours()<11)||(now.getHours()>=17&&now.getHours()<21)?'peak':now.getHours()>=23||now.getHours()<7?'valley':'flat',
        dailyCost: Math.round((pricing.basePrice ? pricing.basePrice.reduce((a,b)=>a+b,0)/48 : 350) * 30 / 10),
        _source: pricing._source,
        _fetchedAt: pricing._fetchedAt,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/events — SSE 实时推送
  if (reqUrl.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    console.log(`[SSE] Client connected (total: ${sseClients.size})`);
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
    req.on('close', () => { sseClients.delete(res); console.log(`[SSE] Client disconnected (total: ${sseClients.size})`); });
    return;
  }

  // === 优化算法 API ===

  // ─── 自动权重计算（根据系统上下文自适应）───
  function computeAutoWeights(ctx) {
    const loadRate = ctx.gridLoadKW / ctx.gridCapacityKW;
    let w1 = 0.35, w2 = 0.25, w3 = 0.25, w4 = 0.15, mode = '均衡优化';

    if (ctx.isFaulted) {
      w1 = 0.10; w2 = 0.15; w3 = 0.65; w4 = 0.10; mode = '故障应急·韧性优先';
    } else if (loadRate > 0.88) {
      w1 = 0.50; w2 = 0.20; w3 = 0.15; w4 = 0.15; mode = '高负载·经济优先';
    } else if (ctx.outdoorTemp >= 37) {
      w1 = 0.25; w2 = 0.45; w3 = 0.15; w4 = 0.15; mode = '极端高温·稳定优先';
    } else if (ctx.outdoorTemp <= 5) {
      w1 = 0.20; w2 = 0.50; w3 = 0.15; w4 = 0.15; mode = '低温寒潮·稳定优先';
    } else if (ctx.hourOfDay >= 17 && ctx.hourOfDay <= 21 && loadRate > 0.75) {
      w1 = 0.30; w2 = 0.20; w3 = 0.35; w4 = 0.15; mode = '晚高峰·韧性优先';
    } else if (loadRate < 0.45) {
      w1 = 0.25; w2 = 0.20; w3 = 0.20; w4 = 0.35; mode = '低负载·低碳优先';
    }

    return { w1, w2, w3, w4, mode };
  }

  // GET /api/optimization/state — 策略推荐引擎
  if (reqUrl.pathname === '/api/optimization/state') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const cti = sysData.currentTimeIndex;
    const pricing = await getRealPricing();

    // 使用稳定的基线负荷（避免深夜时段负荷过低导致数据失真）
    const stableLoad = Math.max(currentState.grid.totalLoad, 2500);
    const stableLoadRate = Math.round(stableLoad / currentState.grid.capacity * 1000) / 10;
    const stableCoolingLoad = Math.round(stableLoad * 0.52);

    const state = {
      outdoorTemp: sysData.temperature.current.outdoor,
      gridLoad: stableLoad,
      gridLoadRate: stableLoadRate,
      coolingLoad: stableCoolingLoad,
      electricityPrice: pricing.realTimePrice ? pricing.realTimePrice[cti] : 350,
      hour: now.getHours(),
      forecast: {
        temperature: sysData.temperature.outdoor,
        peak_temp: Math.max(...sysData.temperature.outdoor),
      },
    };

    const recommendation = algo.recommendStrategies(state);

    // 始终构建全部 5 个策略的详细方案（不论是否被推荐触发）
    const recMap = {};
    recommendation.recommendations.forEach(r => { recMap[r.id] = r; });

    const allStrategyDefs = [
      { id: 'precool', name: '预冷控制', icon: 'snowflake',
        compute: () => algo.computePrecoolingStrategy({ category: 'commercial', T_env_forecast: sysData.temperature.outdoor.slice(0, 24) }),
        defaultTrigger: '凌晨4:00-7:00预冷窗口', defaultScore: 75,
        getSavings: (p) => `${p.net_benefit_kw} kW` },
      { id: 'zone', name: '分区控制', icon: 'layers',
        compute: () => algo.computeZoneControlStrategy({ T_env: state.outdoorTemp }),
        defaultTrigger: '电网负载率偏高时启动', defaultScore: 72,
        getSavings: (p) => `${p.total_saved_kw} kW` },
      { id: 'night_storage', name: '夜间蓄冷', icon: 'battery',
        compute: () => algo.computeNightStorageStrategy({ valley_price: state.electricityPrice }),
        defaultTrigger: '电价低谷时段启动', defaultScore: 85,
        getSavings: (p) => `¥${p.economics.net_benefit_yuan}/天` },
      { id: 'peak_shift', name: '错峰运行', icon: 'shuffle',
        compute: () => algo.computePeakShiftStrategy({}),
        defaultTrigger: '高峰时段17:00-21:00', defaultScore: 75,
        getSavings: (p) => `${p.avg_power_reduction_kw} kW` },
      { id: 'demand_response', name: '需求响应', icon: 'zap',
        compute: () => algo.computeDemandResponseCapability({ total_load_kw: state.gridLoad, cooling_load_kw: state.coolingLoad }),
        defaultTrigger: '待命响应，三级联动可调', defaultScore: 65,
        getSavings: (p) => `最大 ${p.max_reduction_kw} kW` },
    ];

    const detailedStrategies = allStrategyDefs.map(def => {
      const plan = def.compute();
      const rec = recMap[def.id];
      if (rec) {
        return { ...rec, plan };
      }
      // 未触发但仍展示
      return {
        id: def.id, name: def.name, icon: def.icon,
        priority: 'standby', score: def.defaultScore,
        trigger: def.defaultTrigger,
        estimated_savings: def.getSavings(plan),
        action_label: '查看方案',
        plan,
      };
    });

    // 更新 recommendation 以包含全部 5 个策略
    recommendation.recommendations = detailedStrategies;
    recommendation.active_count = detailedStrategies.filter(r => r.priority === 'high').length;
    recommendation.standby_count = detailedStrategies.filter(r => r.priority === 'standby').length;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    // V3 ETP 模型数据
    const etpNodes = [
      { category: 'commercial',  T_out: state.outdoorTemp, T_in: 24.5, s: 1 },
      { category: 'residential', T_out: state.outdoorTemp, T_in: 26.0, s: 1 },
      { category: 'industrial',  T_out: state.outdoorTemp, T_in: 22.5, s: 1 },
      { category: 'datacenter',  T_out: state.outdoorTemp, T_in: 22.0, s: 1 },
      { category: 'hospital',    T_out: state.outdoorTemp, T_in: 23.0, s: 1 },
    ];
    const etpAgg = algo.computeAggregatedPower(etpNodes, 15);

    // V3 动态权重（式11/式12）
    const dynamicWeights = ['commercial', 'residential', 'industrial', 'datacenter', 'hospital'].map(cat => {
      const p = algo.ETP_PARAMS[cat];
      const acWeight = algo.computeACWeight(cat, p.T_target, 1.0, 0.5);
      const storageWeight = algo.computeStorageWeight(0.5, 1.0, 0.5);
      return {
        category: cat,
        omega_ac: acWeight.omega,
        omega_storage: storageWeight.omega,
        T_target: p.T_target,
        T_min: p.T_target - p.delta / 2,
        T_max: p.T_target + p.delta / 2,
        priority: p.priority,
      };
    });

    // V3 综合目标函数（式8）
    const objectiveV3 = algo.computeObjectiveV3({
      T_out: state.outdoorTemp,
      dt: 0.5,
    });

    // V2 兼容数据（保持前端不中断）
    const coolingModelV2 = algo.computeCoolingPowerV2('commercial', state.outdoorTemp, 55, state.outdoorTemp - 0.5, 0);
    const objectiveV2 = algo.computeObjectiveV2({
      energy: stableLoad * 24 / 1000,
      tempDeviation: Math.abs(24.0 - state.outdoorTemp) * 5,
      recoveryCost: 500 * 0.3,
      gridLoad: stableLoadRate > 85 ? stableLoad : stableLoad * 0.95,
      gridCapacity: currentState.grid.capacity,
      zoneComforts: [
        { actual: 22.9, target: 24.0, tolerance: 2.0, cost: 0.12 },
        { actual: 25.5, target: 26.0, tolerance: 0.5, cost: 0.30 },
        { actual: 21.8, target: 22.0, tolerance: 3.0, cost: 0.06 },
        { actual: 21.2, target: 22.0, tolerance: 0.5, cost: 0.40 },
        { actual: 22.5, target: 23.0, tolerance: 0.3, cost: 0.35 },
      ],
    });

    res.end(JSON.stringify({
      recommendation,
      detailedStrategies,
      coolingModel: coolingModelV2,
      objectiveV2,
      // V3 新增数据
      etpModel: {
        aggregatedPower: etpAgg,
        dynamicWeights,
        objectiveV3,
        formula: 'P_agg(t) = Σ s_i(t)·P_rated_i·[1+δ_reflow_i(t)]',
        outdoorTemp: state.outdoorTemp,
      },
      autoWeights: computeAutoWeights({
        gridLoadKW: stableLoad,
        gridCapacityKW: currentState.grid.capacity,
        outdoorTemp: state.outdoorTemp,
        hourOfDay: now.getHours(),
        isFaulted: false,
      }),
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/plans — 故障恢复方案比选
  if (reqUrl.pathname === '/api/optimization/plans') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const T_env = sysData.temperature.current.outdoor;

    // V3 故障恢复优化（式4/8/9/10）
    const recoveryOpt = algo.optimizeFaultRecovery({
      fault_zone: 'commercial',
      T_out: T_env,
      available_zones: ['residential', 'industrial', 'datacenter', 'hospital'],
      dt: 0.5,
    });

    // V3 恢复收益计算（式9）
    const recoveryBenefitNodes = [
      { category: 'commercial',  T_out: T_env, T_in: 26.5, P_restore: 800 },
      { category: 'residential', T_out: T_env, T_in: 27.0, P_restore: 500 },
      { category: 'industrial',  T_out: T_env, T_in: 24.0, P_restore: 400 },
      { category: 'datacenter',  T_out: T_env, T_in: 23.5, P_restore: 300 },
      { category: 'hospital',    T_out: T_env, T_in: 24.0, P_restore: 250 },
    ];
    const recoveryBenefit = algo.computeRecoveryBenefit(recoveryBenefitNodes, 0.5);

    // V3 回流功率恢复时间（式4）
    const recoveryTimes = ['commercial', 'residential', 'industrial', 'datacenter', 'hospital'].map(cat => {
      const p = algo.ETP_PARAMS[cat];
      const T_recovery = p.T_target + p.delta; // 故障后温度上升至 T_target + delta
      return algo.computeRecoveryOnTime(cat, T_env, T_recovery);
    });

    // 模拟3个恢复方案
    const recoveryPlans = [
      {
        id: 'plan_a',
        name: '方案A：商业优先',
        description: '优先恢复商业区全供电，居民区轮流供电',
        affected_load_kw: 850,
        extra_power_kw: 120,
        duration_min: 45,
        priority_label: '经济优先',
      },
      {
        id: 'plan_b',
        name: '方案B：民生优先',
        description: '保居民基础供电，商业区降容50%',
        affected_load_kw: 650,
        extra_power_kw: 180,
        duration_min: 35,
        priority_label: '民生优先',
      },
      {
        id: 'plan_c',
        name: '方案C：储能+柴油机',
        description: '启动光纤储能+柴油发电机，全区域恢复',
        affected_load_kw: 500,
        extra_power_kw: 350,
        duration_min: 25,
        priority_label: '韧性优先',
      },
    ];

    const scored = algo.scoreRecoveryPlans(recoveryPlans, { fault_active: true });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...scored,
      // V3 新增数据
      etpRecovery: {
        recoveryOptimization: recoveryOpt,
        recoveryBenefit,
        recoveryTimes,
        formula: 't_on_rec = R·C·ln[(T_rec-T_ss)/(T_max-T_ss)]',
        outdoorTemp: T_env,
      },
      current_load: sysData.load.current.total,
      affected_zones: ['居民社区B', '商业B区-2F', '商业B区-3F'],
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/forecast — 策略效果预测
  if (reqUrl.pathname === '/api/optimization/forecast') {
    const now = new Date();
    const sysData = generateSystemData(now);

    // 模拟执行全部5个策略
    const simulation = algo.simulateOptimization(
      { gridLoad: sysData.load.current.total },
      ['precool', 'zone', 'night_storage', 'peak_shift', 'demand_response']
    );

    // 生成24h优化前后对比曲线 — V2模型
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const T_env = sysData.temperature.outdoor.slice(0, 24);
    while (T_env.length < 24) T_env.push(T_env[T_env.length - 1]);

    // 基准负荷（V2模型，不做优化）
    const baselineLoad = hours.map(h => {
      const t = T_env[Math.min(h, T_env.length - 1)];
      const tp = h > 0 ? T_env[h - 1] : t;
      const comm = algo.computeCoolingPowerV2('commercial', t, 55, tp, 0);
      const resi = algo.computeCoolingPowerV2('residential', t, 60, tp, 0);
      return Math.round(comm.power + resi.power + 500 + Math.random() * 200);
    });

    // 优化后负荷（V2模型 + 5策略叠加）
    const optimizedLoad = hours.map((load, h) => {
      const t = T_env[h], tp = h > 0 ? T_env[h - 1] : t;
      // 预冷效果：假设凌晨4-7点预冷
      const precoolOffset = (h >= 13 && h <= 17) ? -3.5 * Math.exp(-(h - 7) * 0.15) : 0;
      // 分区+错峰效果
      const zoneOffset = (h >= 10 && h <= 20) ? 1.8 : 0;
      const comm = algo.computeCoolingPowerV2('commercial', t, 55, tp, precoolOffset + zoneOffset);
      const resi = algo.computeCoolingPowerV2('residential', t, 60, tp, zoneOffset * 0.5);
      let opt = Math.round((comm.power + resi.power) * 0.88 + 450);
      // 蓄冷减少白天负荷
      if (h >= 10 && h <= 20) opt -= 180;
      // 错峰
      if ((h >= 17 && h <= 20) && (h % 2 === 0)) opt -= 75;
      return opt;
    });

    // V3 ETP 聚合功率对比（式5）
    const etpBaseline = hours.map(h => {
      const t = T_env[Math.min(h, T_env.length - 1)];
      const nodes = [
        { category: 'commercial',  T_out: t, T_in: 24.5, s: 1 },
        { category: 'residential', T_out: t, T_in: 26.0, s: 1 },
        { category: 'industrial',  T_out: t, T_in: 22.5, s: 1 },
        { category: 'datacenter',  T_out: t, T_in: 22.0, s: 1 },
        { category: 'hospital',    T_out: t, T_in: 23.0, s: 1 },
      ];
      return algo.computeAggregatedPower(nodes, 15).totalPower;
    });

    // V3 ETP 优化后（预冷+分区策略影响）
    const etpOptimized = hours.map(h => {
      const t = T_env[Math.min(h, T_env.length - 1)];
      const precoolOffset = (h >= 13 && h <= 17) ? -3.5 * Math.exp(-(h - 7) * 0.15) : 0;
      const zoneOffset = (h >= 10 && h <= 20) ? 1.8 : 0;
      const nodes = [
        { category: 'commercial',  T_out: t, T_in: 24.5 + precoolOffset + zoneOffset, s: 1 },
        { category: 'residential', T_out: t, T_in: 26.0 + zoneOffset * 0.5, s: 1 },
        { category: 'industrial',  T_out: t, T_in: 22.5, s: 1 },
        { category: 'datacenter',  T_out: t, T_in: 22.0, s: 1 },
        { category: 'hospital',    T_out: t, T_in: 23.0, s: 1 },
      ];
      let p = algo.computeAggregatedPower(nodes, 15).totalPower;
      if (h >= 10 && h <= 20) p = Math.round(p * 0.85);
      return p;
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hours,
      baseline: { load: baselineLoad, peak: Math.max(...baselineLoad), total_kwh: Math.round(baselineLoad.reduce((s, v) => s + v, 0)) },
      optimized: { load: optimizedLoad, peak: Math.max(...optimizedLoad), total_kwh: Math.round(optimizedLoad.reduce((s, v) => s + v, 0)) },
      // V3 ETP 对比数据
      etpBaseline,
      etpOptimized,
      etpSavings: {
        peak_reduction_kw: Math.round(Math.max(...etpBaseline) - Math.max(...etpOptimized)),
        peak_reduction_pct: Math.round((1 - Math.max(...etpOptimized) / Math.max(...etpBaseline)) * 100),
        energy_saved_kwh: Math.round(etpBaseline.reduce((s, v) => s + v, 0) - etpOptimized.reduce((s, v) => s + v, 0)),
      },
      savings: {
        peak_reduction_kw: Math.round(Math.max(...baselineLoad) - Math.max(...optimizedLoad)),
        peak_reduction_pct: Math.round((1 - Math.max(...optimizedLoad) / Math.max(...baselineLoad)) * 100),
        energy_saved_kwh: Math.round(baselineLoad.reduce((s, v) => s + v, 0) - optimizedLoad.reduce((s, v) => s + v, 0)),
      },
      simulation,
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/mpc — MPC 滚动时域优化
  if (reqUrl.pathname === '/api/optimization/mpc') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const T_env = sysData.temperature.outdoor.slice(0, 24);

    // 构造湿度、电价序列
    const RH_series = Array.from({ length: 24 }, (_, i) => {
      const base = { 0: 55, 4: 62, 8: 58, 12: 48, 16: 45, 20: 52, 23: 56 };
      return (base[i] || 50) + (Math.random() - 0.5) * 8;
    });
    const price_series = Array.from({ length: 24 }, (_, i) => {
      if (i < 7) return 200 + Math.random() * 30;
      if (i >= 10 && i <= 12) return 450 + Math.random() * 50;
      if (i >= 17 && i <= 20) return 500 + Math.random() * 60;
      return 300 + Math.random() * 80;
    });

    const mpcResult = algo.mpcOptimize({
      T_env_forecast: T_env,
      price_forecast: price_series,
      gridCapacity: 3500,
      N_horizon: 6,
      dt_min: 30,
    });

    // V3 ETP 模型功率对比
    const powerComparison = (mpcResult.recommendations || []).map((rec, i) => {
      const T0 = T_env[0] || 30;
      const duty = algo.computeDutyCycle(rec.category, T0);
      const oldModel = algo.computeCoolingPower(rec.category, T0, 0);
      const newModel = algo.computeCoolingPowerV2(rec.category, T0, 55, T0, 0);
      return {
        zoneId: rec.zoneId,
        category: rec.category,
        oldPower: oldModel.power,
        newPower: newModel.power,
        duty: duty.duty,
        t_on: duty.t_on,
        t_off: duty.t_off,
        T_target: newModel.T_target,
        thermalMass: newModel.thermalMass,
        cop: newModel.cop,
        recommendedOffset: rec.recommendedOffset,
        newTarget: rec.newTarget,
        action: rec.action,
        energy: rec.energy,
        cost: rec.cost,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...mpcResult, powerComparison, timestamp: now.toISOString() }));
    return;
  }

  // GET /api/optimization/etp — ETP 等效热参数模型完整数据
  if (reqUrl.pathname === '/api/optimization/etp') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const T_env = sysData.temperature.current.outdoor;
    const categories = ['commercial', 'residential', 'industrial', 'datacenter', 'hospital'];

    const etpData = categories.map(cat => {
      const p = algo.ETP_PARAMS[cat];
      const T_max = p.T_target + p.delta / 2;
      const T_min = p.T_target - p.delta / 2;
      const T_ss_on = T_env - p.R * p.eta * p.P_rated;
      const T_ss_off = T_env;

      // 式(1) ETP 模型
      const etp_on = algo.etpModel(cat, p.T_target, T_env, 15, 1);
      const etp_off = algo.etpModel(cat, p.T_target, T_env, 15, 0);

      // 式(2)(3) 开停机时间
      const onTime = algo.computeOnTime(cat, T_env);
      const offTime = algo.computeOffTime(cat, T_env);
      const duty = algo.computeDutyCycle(cat, T_env);

      // 式(4) 回流功率恢复时间
      const T_recovery = T_max + 2; // 故障后温度超调 2°C
      const recovery = algo.computeRecoveryOnTime(cat, T_env, T_recovery);

      // 式(11) 动态权重
      const acWeight_normal = algo.computeACWeight(cat, p.T_target, 1.0, 0.5);
      const acWeight_max = algo.computeACWeight(cat, T_max, 1.0, 0.5);
      const acWeight_min = algo.computeACWeight(cat, T_min, 1.0, 0.5);

      return {
        category: cat,
        params: {
          R: p.R, C: p.C, eta: p.eta, P_rated: p.P_rated,
          T_target: p.T_target, delta: p.delta,
          T_max, T_min, N_units: p.N_units, zone_power: p.zone_power,
          comfort_tol: p.comfort_tol, priority: p.priority,
        },
        // 式(1) ETP
        etp: {
          T_ss_on: Math.round(T_ss_on * 100) / 100,
          T_ss_off: T_ss_off,
          tau: p.R * p.C,
          T_in_after_15min_on: etp_on.T_in,
          T_in_after_15min_off: etp_off.T_in,
        },
        // 式(2)(3) 开停机时间
        dutyCycle: {
          t_on: duty.t_on,
          t_off: duty.t_off,
          duty: duty.duty,
          duty_pct: duty.duty_pct,
          cycle: duty.cycle,
          cycle_min: duty.cycle_min,
          avgPower: duty.avgPower,
        },
        // 式(4) 回流恢复
        recovery: {
          t_on_recovery: recovery.t_on_recovery,
          t_on_recovery_min: recovery.t_on_recovery_min,
          t_on_normal: recovery.t_on_normal,
          overshoot_ratio: recovery.overshoot_ratio,
          T_recovery: recovery.T_recovery,
          reflowFactor: recovery.reflowFactor,
          P_reflow: recovery.P_reflow,
        },
        // 式(11) 动态权重
        dynamicWeight: {
          omega_at_target: acWeight_normal.omega,
          omega_at_Tmax: acWeight_max.omega,
          omega_at_Tmin: acWeight_min.omega,
          T_norm_at_target: acWeight_normal.T_norm,
          kappa_T: 0.5,
          omega_base: 1.0,
        },
        // 聚合功率
        aggregatedPower: Math.round(p.zone_power * duty.duty * 100) / 100,
        activeUnits: Math.round(p.N_units * duty.duty),
      };
    });

    // 式(5) 总聚合功率
    const allNodes = categories.map(cat => {
      const p = algo.ETP_PARAMS[cat];
      return { category: cat, T_out: T_env, T_in: p.T_target, s: 1 };
    });
    const totalAgg = algo.computeAggregatedPower(allNodes, 15);

    // 式(12) 蓄热动态权重
    const storageWeight = algo.computeStorageWeight(0.5, 1.0, 0.5);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      outdoorTemp: T_env,
      categories: etpData,
      totalAggregatedPower: totalAgg,
      storageDynamicWeight: storageWeight,
      formula: {
        '式(1)': 'C·dT_in/dt = (T_out-T_in)/R - s·η·P',
        '式(2)': 't_on = R·C·ln[(T_max-T_ss)/(T_min-T_ss)]',
        '式(3)': 't_off = R·C·ln[(T_out-T_min)/(T_out-T_max)]',
        '式(4)': 't_on_rec = R·C·ln[(T_rec-T_ss)/(T_max-T_ss)]',
        '式(5)': 'P_agg(t) = Σ s_i(t)·P_rated_i·[1+δ_reflow_i(t)]',
        '式(11)': 'ω = ω_base + κ_T·(T_in-T_min)/(T_max-T_min)',
        '式(12)': 'ω = ω_base + κ_S·(SOC_max-SOC)/(SOC_max-SOC_min)',
      },
      version: 'v3.0-ETP',
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/supply-demand — 供需平衡优化
  if (reqUrl.pathname === '/api/optimization/supply-demand') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const T_env = sysData.temperature.current.outdoor;

    // 使用稳定的基线负荷（避免深夜时段需求过低导致机组调度失真）
    const stableSDDemand = Math.max(currentState.grid.totalLoad, 2500);
    const sdResult = algo.supplyDemandOptimize({
      totalDemand: stableSDDemand,
      gridCapacity: currentState.grid.capacity,
      carbonPrice: 60 + Math.round(Math.sin(Date.now() / 86400000) * 20),
    });

    // V3 ETP 聚合功率（式5）— 温控负荷聚合
    const tclNodes = [
      { category: 'commercial',  T_out: T_env, T_in: 24.5, s: 1 },
      { category: 'residential', T_out: T_env, T_in: 26.0, s: 1 },
      { category: 'industrial',  T_out: T_env, T_in: 22.5, s: 1 },
      { category: 'datacenter',  T_out: T_env, T_in: 22.0, s: 1 },
      { category: 'hospital',    T_out: T_env, T_in: 23.0, s: 1 },
    ];
    const tclAgg = algo.computeAggregatedPower(tclNodes, 15);

    // 碳排放汇总
    const emissionSummary = {
      totalKgCO2: sdResult.summary?.totalEmissionKgCO2 || 0,
      totalCarbonCostYuan: sdResult.summary?.totalCarbonCostYuan || 0,
      renewableShare: sdResult.summary?.renewablePercent || 0,
      avgEmissionPerKWh: sdResult.totalDemandKW ? Math.round((sdResult.summary?.totalEmissionKgCO2 || 0) / sdResult.totalDemandKW * 1000) / 1000 : 0,
      complianceLevel: (sdResult.summary?.totalEmissionKgCO2 || 0) < 1200 ? '达标' : (sdResult.summary?.totalEmissionKgCO2 || 0) < 1800 ? '接近上限' : '超标',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...sdResult,
      // V3 新增数据
      etpAggregatedPower: tclAgg,
      tclSummary: {
        totalTCLPower: tclAgg.totalPower,
        totalUnits: tclAgg.totalUnits,
        activeRatio: tclAgg.activeRatio,
        tclShareOfDemand: Math.round(tclAgg.totalPower / stableSDDemand * 1000) / 10,
        formula: 'P_agg(t) = Σ s_i(t)·P_rated_i·[1+δ_reflow_i(t)]',
      },
      emissionSummary,
      gridStatus: { loadRate: Math.round(stableSDDemand / currentState.grid.capacity * 1000) / 10, capacity: currentState.grid.capacity },
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/nash — 博弈论多目标优化
  if (reqUrl.pathname === '/api/optimization/nash') {
    const now = new Date();
    const sysData = generateSystemData(now);
    // 使用日内峰值温度进行博弈论优化（代表最严峻场景）
    const T_env_peak = Math.max(...sysData.temperature.outdoor);
    const T_env_current = sysData.temperature.current.outdoor;
    // 使用适中温度 30°C 进行博弈分析（既有制冷需求又不至于过度约束）
    const T_env = Math.max(T_env_current, 30);

    // 自定义区域参数：P_max 与 disagreement 点适配 30°C 场景
    const nashZones = [
      { id: 'commercial',  category: 'commercial',  T_target: 24, T_current: 23.5, powerKW: 1200, P_max: 2500, comfortWeight: 0.6, powerWeight: 0.4, disagreement: 0.30, tolerance: 2.0 },
      { id: 'residential', category: 'residential', T_target: 26, T_current: 26.2, powerKW: 850,  P_max: 1800, comfortWeight: 0.8, powerWeight: 0.2, disagreement: 0.35, tolerance: 0.5 },
      { id: 'industrial',  category: 'industrial',   T_target: 22, T_current: 22.3, powerKW: 650,  P_max: 2500, comfortWeight: 0.3, powerWeight: 0.7, disagreement: 0.20, tolerance: 3.0 },
      { id: 'datacenter',  category: 'datacenter',   T_target: 22, T_current: 22.1, powerKW: 500,  P_max: 2500, comfortWeight: 0.9, powerWeight: 0.1, disagreement: 0.35, tolerance: 0.5 },
      { id: 'hospital',    category: 'hospital',     T_target: 23, T_current: 23.1, powerKW: 400,  P_max: 1800, comfortWeight: 0.95,powerWeight: 0.05,disagreement: 0.40, tolerance: 0.3 },
    ];

    // 功率预算设为略高于无约束总功率，留出协商空间
    const nashResult = algo.nashBargainingOptimize({ T_env, RH: 55, totalPowerBudget: 7200, zones: nashZones });

    // V3 动态权重补充
    const nashDynamicWeights = nashZones.map(z => {
      const acW = algo.computeACWeight(z.category, z.T_current, 1.0, 0.5);
      return {
        zoneId: z.id,
        category: z.category,
        omega_ac: acW.omega,
        T_norm: acW.T_norm,
        T_current: z.T_current,
        T_target: z.T_target,
      };
    });

    // 帕累托分析
    const paretoAnalysis = (nashResult.allocations || []).map(a => ({
      zoneId: a.id,
      comfortUtility: a.utilities?.comfort,
      powerUtility: a.utilities?.power,
      isParetoOptimal: (a.gainOverDisagreement || 0) > 0,
      gainPercent: Math.round((a.gainOverDisagreement || 0) * 100),
      dynamicWeight: a.dynamic_weight,
    }));

    const allParetoOptimal = paretoAnalysis.every(p => p.isParetoOptimal);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...nashResult,
      paretoAnalysis,
      allParetoOptimal,
      // V3 新增
      etpDynamicWeights: nashDynamicWeights,
      summary: {
        fairnessRating: nashResult.fairness?.interpretation || 'N/A',
        nashEfficiency: nashResult.nashProduct > 1e-16 ? 'efficient' : 'inefficient',
        totalPower: nashResult.totalPowerKW,
        budgetCompliance: nashResult.withinBudget ? '在预算内' : '超预算',
      },
      timestamp: now.toISOString(),
    }));
    return;
  }

  // GET /api/optimization/model-compare — 新旧模型对比 (V1 vs V3 ETP)
  if (reqUrl.pathname === '/api/optimization/model-compare') {
    const now = new Date();
    const sysData = generateSystemData(now);
    const T_env = sysData.temperature.current.outdoor;
    const RH = 55;

    const categories = ['commercial', 'residential', 'industrial', 'datacenter', 'hospital'];
    const comparison = categories.map(cat => {
      const p = algo.ETP_PARAMS[cat];
      const oldM = algo.computeCoolingPower(cat, T_env, 0);
      const newM = algo.computeCoolingPowerV2(cat, T_env, RH, T_env - 0.5, 0);

      // V3 ETP 详细数据
      const duty = algo.computeDutyCycle(cat, T_env);
      const onTime = algo.computeOnTime(cat, T_env);
      const offTime = algo.computeOffTime(cat, T_env);
      const etp = algo.etpModel(cat, p.T_target, T_env, 15, 1);
      const acWeight = algo.computeACWeight(cat, p.T_target, 1.0, 0.5);

      return {
        category: cat,
        oldModel: { power: oldM.power, deviation: oldM.deviation, cop: oldM.cop },
        newModel: {
          power: newM.power, deviation: newM.deviation, cop: newM.cop,
          T_target: newM.T_target, thermalMass: newM.thermalMass, duty: newM.duty,
        },
        // V3 ETP 详细
        etpDetails: {
          R: p.R, C: p.C, eta: p.eta, P_rated: p.P_rated,
          T_target: p.T_target, T_min: p.T_target - p.delta / 2,
          T_max: p.T_target + p.delta / 2,
          T_ss_on: etp.T_ss, tau: etp.tau,
          t_on: duty.t_on, t_off: duty.t_off,
          duty: duty.duty, duty_pct: duty.duty_pct,
          cycle: duty.cycle, avgPower: duty.avgPower,
          omega_ac: acWeight.omega, T_norm: acWeight.T_norm,
          zone_power: p.zone_power, N_units: p.N_units,
        },
        powerDelta: Math.round((newM.power - oldM.power) * 100) / 100,
        powerDeltaPercent: oldM.power > 0 ? Math.round((newM.power - oldM.power) / oldM.power * 100 * 10) / 10 : 0,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      comparison,
      T_env, RH,
      modelVersion: 'v3.0-ETP',
      formulas: ['式(1) ETP', '式(2) t_on', '式(3) t_off', '式(11) 动态权重'],
      timestamp: now.toISOString(),
    }));
    return;
  }

  // 静态文件服务
  let filePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  filePath = path.join(__dirname, filePath);

  // 安全检查：防止目录穿越
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ===========================================================================
// WebSocket 服务
// ===========================================================================
const wss = new WebSocketServer({ server });

// 当前运行状态（每轮 tick 生成新对象，旧对象由 GC 回收）
let currentState = cloneState(BASE);

wss.on('connection', (ws, req) => {
  // WebSocket 认证：检查 cookie 中的 token
  const cookie = req.headers.cookie || '';
  const tokenMatch = cookie.match(/jxzd_auth_token=([^;]+)/);
  const token = tokenMatch ? tokenMatch[1] : null;
  const session = validateToken(token);
  if (!session) {
    ws.close(4001, 'Unauthorized');
    console.log('[WS] Connection rejected: unauthorized');
    return;
  }

  console.log(`[WS] Client connected (${session.username}). Total: ${wss.clients.size}`);

  // 发送初始全量数据（深拷贝，客户端不影响服务端）
  const acUnits = makeAcUnits();
  const genUnits = makeGenUnits();
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      ...cloneState(currentState),
      acUnits,
      genUnits,
    },
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'command') {
        console.log(`[CMD] ${data.action}:`, data.payload);

        // 真正执行指令，可能返回新状态
        const newState = handleCommand(data.action, data.payload, currentState);
        if (newState) {
          currentState = newState;
          // 指令成功执行后，立即广播一次新状态
          broadcast();
        }

        ws.send(JSON.stringify({
          type: 'cmdAck',
          action: data.action,
          success: true,
          ts: Date.now(),
        }));
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Total: ${wss.clients.size}`);
  });
});

// 广播状态更新给所有客户端（每次广播都发送深拷贝快照）
function broadcast() {
  const snapshot = cloneState(currentState);
  const acUnits = makeAcUnits();
  const genUnits = makeGenUnits();
  const msg = JSON.stringify({
    type: 'update',
    data: { ...snapshot, acUnits, genUnits },
    ts: Date.now(),
  });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

// ===========================================================================
// 启动
// ===========================================================================
server.listen(PORT, () => {
  console.log(`\n  ⚡ 阶序智调 后端服务已启动`);
  console.log(`  ├─ HTTP:  http://localhost:${PORT}`);
  console.log(`  ├─ WS:    ws://localhost:${PORT}`);
  console.log(`  ├─ API:   GET /api/state, /api/optimization/*`);
  console.log(`  ├─ Auth:  POST /api/login | GET /api/auth-check (session级)`);
  console.log(`  └─ 管理员: admin / jxzd2026\n`);
});

// 每 2 秒 tick 一次并广播（tick 内部深拷贝，不污染输入）
setInterval(() => {
  currentState = tick(currentState);
  broadcast();
}, 2000);

console.log('[模拟] 实时数据引擎已就绪 (2s 刷新间隔)\n');
