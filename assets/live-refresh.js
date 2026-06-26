/**
 * live-refresh.js — 大屏实时数据刷新引擎
 * 
 * 功能:
 * 1. 系统时钟 + 运行状态灯实时更新
 * 2. 监听systemData变化自动刷新KPI
 * 3. 数据源状态指示器（真实/仿真/离线）
 * 4. 页面间共享的刷新逻辑
 * 
 * 使用: <script src="assets/live-refresh.js"></script>
 *       放在 systemData.js 之后引入
 */

(function () {
  'use strict';

  // ========== 时钟更新 ==========
  let clockInterval = null;

  function startClock() {
    const clockEl = document.getElementById('clk');
    if (!clockEl) return;

    function tick() {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    tick();
    clockInterval = setInterval(tick, 1000);
  }

  // ========== 运行状态灯 ==========
  function updateStatusLight() {
    const statusEl = document.getElementById('wsSt');
    if (!statusEl) return;

    const status = window.systemData.getStatus();
    if (status.realTime && status.dataAge < 15000) {
      statusEl.textContent = '● 实时';
      statusEl.style.color = '#00ff88';
      statusEl.style.textShadow = '0 0 8px rgba(0,255,136,0.4)';
    } else if (status.source === 'simulation' || status.source === 'fallback') {
      statusEl.textContent = '● 仿真';
      statusEl.style.color = '#ffaa00';
      statusEl.style.textShadow = '0 0 8px rgba(255,170,0,0.4)';
    } else {
      statusEl.textContent = '● 离线';
      statusEl.style.color = '#ff4444';
      statusEl.style.textShadow = '0 0 8px rgba(255,68,68,0.4)';
    }
  }

  // ========== 数据源指示器 ==========
  function createSourceIndicator() {
    // 如果页面已有 #dataSource 元素则不重复创建
    if (document.getElementById('dataSource')) return;

    const el = document.createElement('div');
    el.id = 'dataSource';
    el.style.cssText = 'position:fixed;bottom:6px;right:12px;font-size:9px;color:rgba(160,200,255,.3);z-index:9999;font-family:monospace;pointer-events:none;';
    document.body.appendChild(el);
  }

  function updateSourceIndicator() {
    const el = document.getElementById('dataSource');
    if (!el) return;

    const status = window.systemData.getStatus();
    const pricing = window.systemData.get()?.pricing;

    if (pricing?.source === 'real') {
      el.textContent = '📡 电价: 真实数据 | ' + (pricing.date || '');
      el.style.color = 'rgba(0,255,136,.35)';
    } else if (status.sseConnected) {
      el.textContent = '📡 数据: 实时 | SSE 已连接';
      el.style.color = 'rgba(0,210,255,.35)';
    } else if (status.realTime) {
      el.textContent = '📡 数据: 实时 | 轮询中';
      el.style.color = 'rgba(0,210,255,.35)';
    } else {
      el.textContent = '⚠ 离线模式 | 本地兜底数据';
      el.style.color = 'rgba(255,170,0,.4)';
    }
  }

  // ========== KPI 自动更新器 ==========

  /**
   * 绑定KPI元素: data-kpi="field.path" 属性
   * 示例: <span data-kpi="load.current.total">0</span>
   *        <span data-kpi="temperature.current.outdoor" data-unit="°C">0</span>
   *        <span data-kpi="grid.frequency" data-precision="2">0</span>
   */
  function updateKPIs(data) {
    const kpiElements = document.querySelectorAll('[data-kpi]');
    kpiElements.forEach(el => {
      const path = el.getAttribute('data-kpi');
      const unit = el.getAttribute('data-unit') || '';
      const precision = parseInt(el.getAttribute('data-precision')) || 0;
      const format = el.getAttribute('data-format') || 'number'; // number | percent

      let value = getNestedValue(data, path);

      if (value === undefined || value === null) return;

      if (format === 'percent') {
        el.textContent = value.toFixed(precision) + '%';
      } else if (typeof value === 'number') {
        el.textContent = value.toFixed(precision) + (unit ? ' ' + unit : '');
      } else {
        el.textContent = value + (unit ? ' ' + unit : '');
      }
    });
  }

  /**
   * 从嵌套路径获取值
   * "load.current.total" → data.load.current.total
   */
  function getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => (o || {})[k], obj);
  }

  // ========== 图表刷新辅助 ==========

  /**
   * 刷新ECharts图表(如果有chart实例)
   */
  function refreshCharts(chartInstances) {
    if (!chartInstances || !Array.isArray(chartInstances)) return;

    const data = window.systemData.get();
    if (!data) return;

    chartInstances.forEach(chart => {
      if (!chart || chart.isDisposed()) return;
      try {
        // 更新当前时间标记线
        const cti = data.currentTimeIndex;
        if (cti >= 0 && chart.getOption()) {
          const option = chart.getOption();
          if (option.series) {
            option.series.forEach(s => {
              if (s.markLine && s.markLine.data) {
                s.markLine.data.forEach(m => {
                  if (m.xAxis !== undefined) m.xAxis = cti;
                });
              }
            });
            chart.setOption(option, { notMerge: true });
          }
        }
      } catch (e) { /* silent */ }
    });
  }

  /**
   * 创建当前时间指示线 (ECharts markLine配置)
   */
  function createNowLine(cti) {
    return {
      silent: true,
      symbol: 'none',
      lineStyle: {
        color: 'rgba(0,255,136,0.5)',
        width: 2,
        type: 'dashed',
      },
      label: {
        show: true,
        formatter: 'NOW',
        color: '#00ff88',
        fontSize: 10,
        position: 'start',
      },
      data: [{ xAxis: cti }],
    };
  }

  // ========== 初始化 ==========

  function init() {
    console.log('[live-refresh] Initializing...');

    // 启动时钟
    startClock();

    // 创建数据源指示器
    createSourceIndicator();

    // 监听数据更新
    if (window.systemData && typeof window.systemData.onUpdate === 'function') {
      window.systemData.onUpdate((data) => {
        // 更新KPI
        updateKPIs(data);

        // 更新状态灯
        updateStatusLight();

        // 更新数据源指示器
        updateSourceIndicator();
      });
    }

    // 定期更新状态灯和指示器（以防onUpdate不触发）
    setInterval(() => {
      updateStatusLight();
      updateSourceIndicator();
    }, 10000);
  }

  // ========== 暴露工具函数 ==========
  window.LiveRefresh = {
    updateKPIs,
    refreshCharts,
    createNowLine,
    getNestedValue,
    updateStatusLight,
    updateSourceIndicator,
    init,
  };

  // 自动启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[live-refresh] v1.0 loaded');
})();
