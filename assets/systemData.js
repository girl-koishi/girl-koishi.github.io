/**
 * systemData.js v3.0 — 动态实时数据加载器
 * 
 * 架构变更:
 * - v2.x: 静态模拟数据(固定CTI=39)
 * - v3.0: 轮询 data-service.js API (localhost:3081)
 *         数据基于真实系统时间动态计算
 *         电价从公开源获取(辽宁省发改委+仿真兜底)
 *
 * 使用方式:
 * 1. 页面引入: <script src="assets/systemData.js"></script>
 * 2. 初始化: systemData.init(callback)
 * 3. 访问数据: systemData.get() / systemData.onUpdate(fn)
 *
 * 兼容: 保留所有旧字段名 (temperature/load/grid/alerts等)
 */

const DATA_SERVICE_URL = ''; // 同端口，server.js 已集成 /api/* 路由
const POLL_INTERVAL = 5000; // 5秒轮询
const SSE_ENABLED = true;   // 优先使用SSE推送

(function () {
  'use strict';

  // ========== 内部状态 ==========
  let _data = null;
  let _listeners = [];
  let _pollTimer = null;
  let _sseSource = null;
  let _initialized = false;
  let _errorCount = 0;
  let _lastUpdate = null;
  let _dataAge = 0;

  // ========== 兼容层工厂函数 ==========

  /**
   * 从服务端数据生成旧的兼容字段
   */
  function buildCompatLayer(serverData) {
    const sd = serverData;
    const cti = sd.currentTimeIndex || 0;

    // lineData - ECharts趋势曲线生成器
    const lineData = (base, range, len) => {
      const result = [];
      for (let i = 0; i < (len || 48); i++) {
        result.push((base || 0) + (range || 100) * Math.sin(i * 0.3 + cti * 0.02));
      }
      return result;
    };

    return {
      // 基本时间
      currentTimeIndex: cti,
      simulationTime: sd.simulationTime,
      timeLabels: sd.timeLabels,

      // 温度 (v2兼容)
      temperature: {
        outdoor: sd.temperature.outdoor || sd.weather.outdoorTemp,
        commercial: {
          indoor: sd.temperature.commercial?.indoor || [],
          current: sd.temperature.commercial?.current || sd.temperature.current?.commercial || 26,
        },
        residential: {
          indoor: sd.temperature.residential?.indoor || [],
          current: sd.temperature.residential?.current || sd.temperature.current?.residential || 27,
        },
        current: {
          outdoor: sd.temperature.current?.outdoor || sd.weather.current?.outdoorTemp || 32,
          commercial: sd.temperature.current?.commercial || 26,
          residential: sd.temperature.current?.residential || 27,
        },
      },

      // 负荷 (v2兼容)
      load: {
        commercial: { series: sd.load.commercial?.series || sd.load.commercial || [], current: sd.load.commercial?.current || sd.load.current?.commercial || 0 },
        residential: { series: sd.load.residential?.series || sd.load.residential || [], current: sd.load.residential?.current || sd.load.current?.residential || 0 },
        total: { series: sd.load.total?.series || sd.load.total || [], current: sd.load.total?.current || sd.load.current?.total || 0 },
        current: { commercial: sd.load.current?.commercial || 0, residential: sd.load.current?.residential || 0, total: sd.load.current?.total || 0 },
      },

      // 电网
      grid: {
        frequency: sd.grid.frequency || 50,
        voltage: sd.grid.voltage || 10.5,
        totalCapacity: sd.grid.totalCapacity || 5200,
        loadRate: sd.grid.loadRate || 60,
      },

      // 能源结构
      energyMix: sd.energyMix || { thermal: 45, wind: 22, solar: 18, storage: 10, hydro: 5 },

      // 告警
      alerts: sd.alerts || [],

      // 兼容旧字段 - 拓扑图
      nodes: sd.nodes || [],
      lines: sd.lines || [],
      flowPaths: sd.flowPaths || [],
      lineData,

      // 兼容旧字段 - 建筑温度
      community: { currentTemp: sd.community?.currentTemp || sd.temperature.current?.residential || 27 },
      wanda: { currentTemp: sd.wanda?.currentTemp || sd.temperature.current?.commercial || 26, currentPower: sd.wanda?.currentPower || sd.load.current?.commercial || 0 },

      // 兼容旧字段 - 设备
      devices: sd.devices || [],
      equipment: sd.equipment || [],
      
      // 建筑KPI
      buildings: sd.buildings || [],

      // 排行榜
      ranking: sd.ranking || [],
      heatmapData: sd.heatmapData || [],

      // 城市
      cities: sd.cities || ['沈阳'],
      currentCity: sd.currentCity || '沈阳',

      // ====== 新增字段 (v3) ======
      
      // 气象全要素
      weather: {
        outdoorTemp: sd.weather.outdoorTemp || [],
        humidity: sd.weather.humidity || [],
        solarIrradiance: sd.weather.solarIrradiance || [],
        windSpeed: sd.weather.windSpeed || [],
        current: {
          outdoorTemp: sd.weather.current?.outdoorTemp || sd.temperature.current?.outdoor || 32,
          humidity: sd.weather.current?.humidity || 55,
          solarIrradiance: sd.weather.current?.solarIrradiance || 0,
          windSpeed: sd.weather.current?.windSpeed || 3.5,
          feelsLike: sd.weather.current?.feelsLike || 32,
        },
      },

      // 温控负荷
      coolingLoad: {
        commercial: sd.coolingLoad?.commercial || { ratio: [] },
        residential: sd.coolingLoad?.residential || { ratio: [] },
        total: {
          current: sd.coolingLoad?.total?.current || 0,
          currentRatio: sd.coolingLoad?.total?.currentRatio || 0,
        },
      },

      // 可再生能源
      renewable: {
        pv: {
          series: sd.renewable?.pv?.series || [],
          current: sd.renewable?.pv?.current || 0,
          capacity: sd.renewable?.pv?.capacity || 300,
          dailyEnergy: sd.renewable?.pv?.dailyEnergy || 0,
        },
        wind: {
          series: sd.renewable?.wind?.series || [],
          current: sd.renewable?.wind?.current || 0,
          capacity: sd.renewable?.wind?.capacity || 200,
          dailyEnergy: sd.renewable?.wind?.dailyEnergy || 0,
        },
        penetration: {
          current: sd.renewable?.penetration?.current || 0,
        },
      },

      // 储能
      battery: {
        soc: {
          series: sd.battery?.soc?.series || [],
          current: sd.battery?.soc?.current || 50,
        },
        power: {
          series: sd.battery?.power?.series || [],
          current: sd.battery?.power?.current || 0,
        },
        state: sd.battery?.state || 'idle',
      },

      // 电价 (真实数据)
      pricing: {
        source: sd.pricing?._source || sd.pricing?.source || 'simulation',
        date: sd.pricing?.date || '',
        current: sd.pricing?.current || 350,
        realTime: sd.pricing?.realTime || sd.pricing?.realTime || 360,
        series: sd.pricing?.series || sd.pricing?.basePrice || [],
        realTimeSeries: sd.pricing?.realTimeSeries || sd.pricing?.realTimePrice || [],
        unit: sd.pricing?.unit || '元/MWh',
        period: sd.pricing?.period || 'flat',
        dailyCost: sd.pricing?.dailyCost || 0,
      },

      // 需求响应
      demandResponse: sd.demandResponse || { currentCapacity: 0 },

      // N-1安全
      n1Security: sd.n1Security || [],

      // 预测
      forecast: sd.forecast || {},

      // 故障统计
      faultStats: sd.faultStats || {},

      // 分区
      zones: sd.zones || {},

      // 碳排放
      carbon: sd.carbon || {},

      // 元数据
      _meta: {
        realTime: sd._realTime !== false,
        timestamp: sd._timestamp || Date.now(),
        dataAge: 0,
        errorCount: _errorCount,
        lastUpdate: _lastUpdate,
        source: 'data-service',
      },
    };
  }

  // ========== 数据获取 ==========

  async function fetchData() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(`${DATA_SERVICE_URL}/api/system-data`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const serverData = await resp.json();
      _data = buildCompatLayer(serverData);
      _data._meta.timestamp = serverData._timestamp || Date.now();
      _data._meta.dataAge = Date.now() - (_data._meta.timestamp || Date.now());
      _lastUpdate = new Date().toISOString();
      _errorCount = 0;

      // 通知所有监听者
      _listeners.forEach(fn => {
        try { fn(_data); } catch (e) { console.error('[systemData] Listener error:', e); }
      });

      return _data;
    } catch (err) {
      _errorCount++;
      console.warn(`[systemData] Fetch failed (${_errorCount}):`, err.message);

      // 如果有旧数据，继续使用
      if (_data) {
        _data._meta.dataAge += POLL_INTERVAL;
        return _data;
      }

      // 完全没有数据，用本地兜底时钟
      return generateFallbackData();
    }
  }

  /**
   * 本地兜底数据生成（当API不可用时）
   */
  function generateFallbackData() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const cti = h * 2 + (m >= 30 ? 1 : 0);

    return {
      currentTimeIndex: cti,
      simulationTime: now.toLocaleString(),
      timeLabels: Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i/2)).padStart(2,'0')}:${i%2===0?'00':'30'}`),
      temperature: {
        outdoor: Array(48).fill(30),
        commercial: { indoor: Array(48).fill(26), current: 26 },
        residential: { indoor: Array(48).fill(27), current: 27 },
        current: { outdoor: 30, commercial: 26, residential: 27 },
      },
      load: {
        commercial: { series: Array(48).fill(1200), current: 1200 },
        residential: { series: Array(48).fill(900), current: 900 },
        total: { series: Array(48).fill(2100), current: 2100 },
        current: { commercial: 1200, residential: 900, total: 2100 },
      },
      grid: { frequency: 50, voltage: 10.5, totalCapacity: 5200, loadRate: 40 },
      energyMix: { thermal: 45, wind: 22, solar: 18, storage: 10, hydro: 5 },
      alerts: [{ title: '数据服务离线', level: 'warning', value: '使用本地兜底数据', time: now.toLocaleTimeString() }],
      nodes: [], lines: [], flowPaths: [],
      lineData: (base, range, len) => Array(len || 48).fill((base || 0) + (range || 100) * 0.5),
      community: { currentTemp: 27 },
      wanda: { currentTemp: 26, currentPower: 1200 },
      devices: [],
      equipment: [],
      pricing: {
        source: 'fallback',
        current: 350,
        realTime: 360,
        series: Array(48).fill(350),
        period: 'flat',
        unit: '元/MWh',
      },
      weather: {
        outdoorTemp: Array(48).fill(30),
        humidity: Array(48).fill(55),
        solarIrradiance: Array(48).fill(0),
        windSpeed: Array(48).fill(3),
        current: { outdoorTemp: 30, humidity: 55, solarIrradiance: 0, windSpeed: 3, feelsLike: 30 },
      },
      renewable: {
        pv: { series: Array(48).fill(0), current: 0, capacity: 300, dailyEnergy: 0 },
        wind: { series: Array(48).fill(50), current: 50, capacity: 200, dailyEnergy: 600 },
        penetration: { current: 5 },
      },
      battery: { soc: { series: Array(48).fill(50), current: 50 }, power: { series: Array(48).fill(0), current: 0 }, state: 'idle' },
      coolingLoad: { total: { current: 400, currentRatio: 20 } },
      _meta: { realTime: false, timestamp: Date.now(), dataAge: 0, errorCount: _errorCount, lastUpdate: null, source: 'fallback' },
    };
  }

  // ========== SSE 连接 ==========

  function connectSSE() {
    if (!SSE_ENABLED) return;

    try {
      const sse = new EventSource(`${DATA_SERVICE_URL}/api/events`);

      sse.onopen = () => {
        console.log('[systemData] SSE connected');
        // SSE连接后降低轮询频率
        if (_pollTimer) {
          clearInterval(_pollTimer);
          _pollTimer = setInterval(fetchData, 30000); // 降为30秒轮询作为兜底
        }
      };

      sse.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') return;
          if (msg.type === 'data-update' && msg.data) {
            _data = buildCompatLayer(msg.data);
            _data._meta.timestamp = msg.data._timestamp || Date.now();
            _data._meta.dataAge = Date.now() - (_data._meta.timestamp || Date.now());
            _lastUpdate = new Date().toISOString();

            _listeners.forEach(fn => {
              try { fn(_data); } catch (e) { console.error('[systemData] Listener error:', e); }
            });
          }
        } catch (e) {
          console.warn('[systemData] SSE parse error:', e.message);
        }
      };

      sse.onerror = () => {
        console.warn('[systemData] SSE error, falling back to polling');
        sse.close();
        _sseSource = null;
        // 恢复快速轮询
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(fetchData, POLL_INTERVAL);
      };

      _sseSource = sse;
    } catch (e) {
      console.warn('[systemData] SSE not supported, using polling');
      _sseSource = null;
    }
  }

  // ========== 公共 API ==========

  /**
   * 初始化数据服务
   * @param {Function} onReady - 首次数据就绪回调
   * @returns {Promise} 
   */
  async function init(onReady) {
    if (_initialized) return _data;

    console.log('[systemData] Initializing...');

    // 首次获取
    await fetchData();

    if (_data) {
      _initialized = true;

      // 尝试SSE
      connectSSE();

      // 启动轮询
      if (!_sseSource) {
        _pollTimer = setInterval(fetchData, POLL_INTERVAL);
      }

      if (typeof onReady === 'function') onReady(_data);
    }

    return _data;
  }

  /**
   * 获取当前数据快照
   */
  function get() {
    return _data;
  }

  /**
   * 注册数据更新回调
   * @param {Function} fn - (data) => {}
   * @returns {Function} 取消注册函数
   */
  function onUpdate(fn) {
    _listeners.push(fn);
    // 如果已有数据，立即触发一次
    if (_data) {
      try { fn(_data); } catch (e) {}
    }
    return () => {
      _listeners = _listeners.filter(l => l !== fn);
    };
  }

  /**
   * 手动刷新数据
   */
  async function refresh() {
    return fetchData();
  }

  /**
   * 获取电价数据（单独接口，更新更快）
   */
  async function getPricing() {
    try {
      const resp = await fetch(`${DATA_SERVICE_URL}/api/pricing`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.warn('[systemData] Pricing fetch failed:', e.message);
      return _data?.pricing || { source: 'offline', current: 350 };
    }
  }

  /**
   * 获取数据状态
   */
  function getStatus() {
    return {
      initialized: _initialized,
      hasData: !!_data,
      realTime: _data?._meta?.realTime || false,
      dataAge: _data?._meta?.dataAge || 0,
      errorCount: _errorCount,
      lastUpdate: _lastUpdate,
      sseConnected: !!_sseSource,
      source: _data?._meta?.source || 'none',
    };
  }

  /**
   * 销毁（清理定时器和SSE）
   */
  function destroy() {
    if (_pollTimer) clearInterval(_pollTimer);
    if (_sseSource) _sseSource.close();
    _listeners = [];
    _initialized = false;
  }

  // ========== 暴露到全局 ==========

  // 保持旧有的 window.systemData 对象兼容
  // 但变为动态更新模式
  window.systemData = {
    init,
    get,
    onUpdate,
    refresh,
    getPricing,
    getStatus,
    destroy,

    // 兼容旧代码的直接属性访问（首次init后会填充）
    get currentTimeIndex() { return _data?.currentTimeIndex || 0; },
    get simulationTime() { return _data?.simulationTime || ''; },
    get timeLabels() { return _data?.timeLabels || []; },
    get temperature() { return _data?.temperature || {}; },
    get load() { return _data?.load || {}; },
    get grid() { return _data?.grid || {}; },
    get energyMix() { return _data?.energyMix || {}; },
    get alerts() { return _data?.alerts || []; },
    get nodes() { return _data?.nodes || []; },
    get lines() { return _data?.lines || []; },
    get flowPaths() { return _data?.flowPaths || []; },
    get community() { return _data?.community || {}; },
    get wanda() { return _data?.wanda || {}; },
    get devices() { return _data?.devices || []; },
    get equipment() { return _data?.equipment || []; },
    get buildings() { return _data?.buildings || []; },
    get ranking() { return _data?.ranking || []; },
    get heatmapData() { return _data?.heatmapData || []; },
    get weather() { return _data?.weather || {}; },
    get renewable() { return _data?.renewable || {}; },
    get battery() { return _data?.battery || {}; },
    get coolingLoad() { return _data?.coolingLoad || {}; },
    get pricing() { return _data?.pricing || {}; },
    get carbon() { return _data?.carbon || {}; },
    get demandResponse() { return _data?.demandResponse || {}; },
    get n1Security() { return _data?.n1Security || []; },
    get forecast() { return _data?.forecast || {}; },
    get faultStats() { return _data?.faultStats || {}; },
    get zones() { return _data?.zones || {}; },
    lineData(base, range, len) {
      return _data?.lineData ? _data.lineData(base, range, len) : Array(len || 48).fill(base || 0);
    },
  };

  // 自动初始化（页面加载后）
  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => init());
    } else {
      init();
    }
  }

  console.log('[systemData] v3.0 loaded — dynamic real-time mode');
})();
