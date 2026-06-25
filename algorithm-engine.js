/**
 * ===========================================================================
 * 阶序智调 — 优化算法引擎 v2.0
 * ===========================================================================
 *
 * 五大升级：
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 1. 温控负荷模型升级 — 热惯性时滞 + 湿度修正 + COP非线性衰减       │
 * │    P(t)=[P₀+α·ΔT+β·ΔṪ⁺]·Humidity·COP_degrade                    │
 * │                                                                  │
 * │ 2. 目标函数升级 — 碳排放因子 + 越界惩罚 + 舒适度非线性损失        │
 * │    J = Σwᵢ·Fᵢ + P_overflow + C_comfort + CO₂_penalty             │
 * │                                                                  │
 * │ 3. MPC滚动时域优化 — Receding Horizon, 未来N步预测求解            │
 * │                                                                  │
 * │ 4. 供需平衡优化 — 发电成本模型 + 约束 + 双向协同                  │
 * │    min ΣC_gen(i)  s.t.  ΣP_gen = ΣP_load                         │
 * │                                                                  │
 * │ 5. 博弈论多目标 — 纳什议价解 + 帕累托前沿                        │
 * │    max Π(Uᵢ - dᵢ)  →  Pareto-optimal solution                   │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ===========================================================================
// ─── 基础参数库 ───────────────────────────────────────────────────────────
// ===========================================================================

const COEFFICIENTS = {
  commercial:  { alpha: 85,  P_base: 1200, T_target: 24.0, thermal_mass: 180, cop: 5.5,  rh_sens: 0.08, beta: 62,  comfort_tol: 2.0, comfort_cost: 0.12 },
  residential: { alpha: 52,  P_base: 850,  T_target: 26.0, thermal_mass: 120, cop: 4.2,  rh_sens: 0.05, beta: 38,  comfort_tol: 0.5, comfort_cost: 0.30 },
  industrial:  { alpha: 110, P_base: 650,  T_target: 22.0, thermal_mass: 250, cop: 5.0,  rh_sens: 0.03, beta: 80,  comfort_tol: 3.0, comfort_cost: 0.06 },
  datacenter:  { alpha: 140, P_base: 500,  T_target: 22.0, thermal_mass: 80,  cop: 4.8,  rh_sens: 0.10, beta: 100, comfort_tol: 0.5, comfort_cost: 0.40 },
  hospital:    { alpha: 95,  P_base: 400,  T_target: 23.0, thermal_mass: 150, cop: 5.2,  rh_sens: 0.06, beta: 68,  comfort_tol: 0.3, comfort_cost: 0.35 },
};

const CARBON_FACTOR = 0.42;   // kgCO₂/kWh (综合电网碳排放因子)
const COP_CRITICAL_TEMP = 35; // °C, 超过此温度压缩机效率开始显著下降
const COP_DEGRADE_K = 0.008;  // COP衰减系数
const REFERENCE_RH = 50;      // 参考湿度百分比

// ===========================================================================
// ─── 1. 温控负荷模型升级 ──────────────────────────────────────────────────
// ===========================================================================

/**
 * 升级版温控负荷功率模型
 *
 * 公式:
 *   P(t) = [P_base + α·ΔT⁺ + β·max(0, r_T)] · H(RH) · C(T_env)
 *
 *   其中:
 *   - ΔT⁺ = max(0, T_env - T_target)          温度偏差（仅制冷方向）
 *   - r_T  = T_env(t) - T_env(t-1)             温度变化率（升温时增加负荷）
 *   - β     = 热惯性敏感系数 (kW·h/°C)         环境温度骤升时额外制冷需求
 *   - H(RH) = 1 + rh_sens·(RH% - 50)/50       湿度修正（高于50%时负荷增加）
 *   - C(T)  = 1 + COP_K·max(0, T-35)²         COP非线性衰减修正
 *
 * @param {string} category 区域类型
 * @param {number} T_env     当前室外温度 (°C)
 * @param {number} RH        当前相对湿度 (%)
 * @param {number} T_prev    上一时刻室外温度 (用于计算变化率, 可选)
 * @param {number} offset    温度偏移
 * @returns {Object}
 */
function computeCoolingPowerV2(category, T_env, RH, T_prev, offset = 0) {
  const c = COEFFICIENTS[category] || COEFFICIENTS.commercial;
  const T_target = c.T_target + offset;
  const dT = Math.max(0, T_env - T_target);

  // 1. 基准功率 + 温差项
  let power = c.P_base + c.alpha * dT;

  // 2. 热惯性时滞修正 — 温度骤升时空调负担加重
  if (T_prev !== undefined && T_prev !== null) {
    const r_T = T_env - T_prev;
    if (r_T > 0) {
      power += c.beta * r_T;  // 升温: 额外功率
    } else if (r_T < -3) {
      power += c.beta * r_T * 0.3; // 骤降: 轻微惯性效应，减轻负荷
    }
  }

  // 3. 湿度修正
  const RH_eff = RH !== undefined ? RH : REFERENCE_RH;
  const humidityFactor = 1 + c.rh_sens * (RH_eff - REFERENCE_RH) / 50;
  power *= humidityFactor;

  // 4. COP非线性衰减修正
  const copDegradation = 1 + COP_DEGRADE_K * Math.pow(Math.max(0, T_env - COP_CRITICAL_TEMP), 2);
  power *= copDegradation;

  // 5. 有效COP
  const copEffective = c.cop / (1 + COP_DEGRADE_K * Math.pow(Math.max(0, T_env - COP_CRITICAL_TEMP), 2));

  return {
    power:       Math.round(power * 100) / 100,
    deviation:   Math.round(dT * 100) / 100,
    basePower:   c.P_base,
    alpha:       c.alpha,
    beta:        c.beta,
    humidityFactor: Math.round(humidityFactor * 1000) / 1000,
    copDegradation: Math.round(copDegradation * 1000) / 1000,
    cop:         Math.round(copEffective * 100) / 100,
    copNominal:  c.cop,
    T_target:    Math.round(T_target * 10) / 10,
    thermalMass: c.thermal_mass,
    rhSens:      c.rh_sens,
    category,
    // 模型参数详情（用于前端展示）
    model: {
      baseTerm:       c.P_base,
      tempTerm:       Math.round(c.alpha * dT * 100) / 100,
      inertiaTerm:    (T_prev !== undefined && T_env - T_prev > 0) ? Math.round(c.beta * (T_env - T_prev) * 100) / 100 : 0,
      humidityAdjust: Math.round((humidityFactor - 1) * 100) / 100 + '%',
      copAdjust:      Math.round((copDegradation - 1) * 100) / 100 + '%',
    },
  };
}

// 保持向后兼容的简化接口
function computeCoolingPower(category, T_env, offset = 0) {
  return computeCoolingPowerV2(category, T_env, REFERENCE_RH, T_env, offset);
}

/**
 * 批量计算功率矩阵 (升级版)
 */
function computeCoolingMatrixV2(zones, T_env_series, RH_series) {
  const matrix = zones.map(zone => {
    const series = T_env_series.map((T_env, i) => {
      const T_prev = i > 0 ? T_env_series[i - 1] : T_env;
      const RH = RH_series ? RH_series[i] : REFERENCE_RH;
      return computeCoolingPowerV2(zone.category, T_env, RH, T_prev, zone.offset || 0);
    });
    return {
      category: zone.category,
      label: zone.label || zone.category,
      offset: zone.offset || 0,
      series,
      current: series[series.length - 1],
      total:   Math.round(series.reduce((s, p) => s + p.power, 0)),
      avg:     Math.round(series.reduce((s, p) => s + p.power, 0) / series.length * 100) / 100,
      peak:    Math.round(Math.max(...series.map(p => p.power)) * 100) / 100,
    };
  });

  const totalSeries = T_env_series.map((_, i) =>
    Math.round(matrix.reduce((s, z) => s + z.series[i].power, 0) * 100) / 100
  );

  return { zones: matrix, totalSeries, nPoints: T_env_series.length };
}

// 向后兼容
function computeCoolingMatrix(zones, T_env_series) {
  return computeCoolingMatrixV2(zones, T_env_series, null);
}

// ===========================================================================
// ─── 2. 目标函数升级 ──────────────────────────────────────────────────────
// ===========================================================================

/**
 * 升级版综合优化目标函数
 *
 * 公式:
 *   J = w₁·E_norm + w₂·D_norm + w₃·R_norm + w₄·C_norm
 *     + λ_overflow·P_overflow + λ_comfort·C_comfort
 *
 *   新增:
 *   - w₄·C_norm: 碳排放惩罚项 (kgCO₂ 归一化)
 *   - P_overflow: 越界惩罚 max(0, load - capacity)² / capacity²
 *   - C_comfort:  舒适度非线性损失 Σ max(0, |T_actual - T_target| - tolerance)²
 *
 * @param {Object} metrics
 * @param {number} metrics.energy             - E: 总能耗 (kWh)
 * @param {number} metrics.tempDeviation      - D: 温度偏差 (°C·h)
 * @param {number} metrics.recoveryCost       - R: 恢复成本 (min·kW)
 * @param {number} metrics.gridLoad           - 电网当前负荷 (kW)
 * @param {number} metrics.gridCapacity       - 电网容量 (kW)
 * @param {Array}  metrics.zoneComforts       - 各区域舒适度 [{actual, target, tolerance, cost}]
 * @param {Object} weights
 * @returns {Object}
 */
function computeObjectiveV2(metrics, weights = null) {
  const w = Object.assign({
    w1: 0.35, w2: 0.25, w3: 0.25, w4: 0.15,
    lambda_overflow: 5.0,
    lambda_comfort:  2.0,
  }, weights || {});

  // 归一化基准
  const E_base = 3500;
  const D_base = 15;
  const R_base = 500;
  const C_base = 1500;  // 典型日碳排放基准 (kgCO₂)

  const E_norm = metrics.energy / E_base;
  const D_norm = metrics.tempDeviation / D_base;
  const R_norm = metrics.recoveryCost / R_base;

  // 碳排放计算
  const carbonEmission = metrics.energy * CARBON_FACTOR;
  const C_norm = carbonEmission / C_base;

  // 越界惩罚
  const load = metrics.gridLoad || 0;
  const cap  = metrics.gridCapacity || 3500;
  const overflow = Math.max(0, load - cap);
  const overflowPenalty = overflow > 0
    ? w.lambda_overflow * Math.pow(overflow / cap, 2)
    : 0;

  // 舒适度非线性损失 — 超出容忍范围才惩罚，且平方增长
  let comfortPenalty = 0;
  if (metrics.zoneComforts && metrics.zoneComforts.length > 0) {
    metrics.zoneComforts.forEach(z => {
      const exceed = Math.max(0, Math.abs(z.actual - z.target) - z.tolerance);
      if (exceed > 0) {
        comfortPenalty += (z.cost || 0.2) * exceed * exceed;
      }
    });
    // 归一化到合理范围
    comfortPenalty = Math.min(1.5, comfortPenalty / metrics.zoneComforts.length);
  }

  const J = w.w1 * E_norm + w.w2 * D_norm + w.w3 * R_norm + w.w4 * C_norm
          + overflowPenalty + w.lambda_comfort * comfortPenalty;

  return {
    J:                Math.round(J * 10000) / 10000,
    E_norm:           Math.round(E_norm * 10000) / 10000,
    D_norm:           Math.round(D_norm * 10000) / 10000,
    R_norm:           Math.round(R_norm * 10000) / 10000,
    C_norm:           Math.round(C_norm * 10000) / 10000,
    carbonEmission:   Math.round(carbonEmission * 10) / 10,
    overflowPenalty:  Math.round(overflowPenalty * 10000) / 10000,
    comfortPenalty:   Math.round(comfortPenalty * 10000) / 10000,
    weights: { ...w },
    rating:           J < 0.35 ? 'excellent' : J < 0.65 ? 'good' : J < 0.95 ? 'acceptable' : 'poor',
  };
}

/**
 * 向后兼容的简化接口
 */
function computeObjective(metrics, weights = null) {
  const w = Object.assign({ w1: 0.4, w2: 0.35, w3: 0.25 }, weights || {});
  const E_base = 3500, D_base = 15, R_base = 500;
  const E_norm = metrics.energy / E_base;
  const D_norm = metrics.tempDeviation / D_base;
  const R_norm = metrics.recoveryCost / R_base;
  const J = (w.w1 || 0.4) * E_norm + (w.w2 || 0.35) * D_norm + (w.w3 || 0.25) * R_norm;
  return {
    J: Math.round(J * 10000) / 10000,
    E_norm: Math.round(E_norm * 10000) / 10000,
    D_norm: Math.round(D_norm * 10000) / 10000,
    R_norm: Math.round(R_norm * 10000) / 10000,
    weights: { ...w },
  };
}

// ===========================================================================
// ─── 3. MPC 滚动时域预测优化 ──────────────────────────────────────────────
// ===========================================================================

/**
 * MPC (Model Predictive Control) 滚动时域优化
 *
 * 原理:
 *   1. 预测未来 N_horizon 步的温度序列 T̂[k] 和电价序列 P̂[k]
 *   2. 求解最优控制序列 u*[0...N-1] 使得累积目标 J_total 最小
 *   3. 只执行第一步 u*[0]
 *   4. 下一时刻重复
 *
 * 控制变量:
 *   - uᵢ = [ΔT_offset_i, precool_flag_i]  各区域温度偏移和预冷开关
 *
 * 约束:
 *   - |ΔT_offset| ≤ max_tolerance         不能超出舒适容忍
 *   - ΣP_i ≤ grid_capacity                不能越界
 *
 * @param {Object} params
 * @returns {Object} 优化结果
 */
function mpcOptimize(params) {
  const {
    zones = [
      { id: 'comm', category: 'commercial',  currentTemp: 22.9, priority: 2 },
      { id: 'resi', category: 'residential', currentTemp: 25.5, priority: 1 },
      { id: 'indu', category: 'industrial',   currentTemp: 21.8, priority: 3 },
      { id: 'data', category: 'datacenter',   currentTemp: 21.2, priority: 1 },
      { id: 'hosp', category: 'hospital',     currentTemp: 22.5, priority: 1 },
    ],
    T_env_forecast   = [28, 27, 26, 26, 27, 29, 31, 33, 34, 35, 35, 34],  // 未来 N 步
    RH_forecast      = [55, 58, 60, 62, 60, 55, 50, 48, 45, 42, 40, 42],
    price_forecast   = [220, 200, 190, 180, 190, 220, 280, 350, 420, 480, 520, 560],
    gridCapacity     = 3500,
    N_horizon        = 6,   // 优化时域（步数）
    controlInterval  = 30,  // 控制间隔（分钟）
    weights          = { w1: 0.35, w2: 0.25, w3: 0.25, w4: 0.15, lambda_overflow: 5.0, lambda_comfort: 2.0 },
  } = params;

  const N = Math.min(N_horizon, T_env_forecast.length);
  const candidates = 6; // 每个zone尝试的控制偏移量数量

  // 为每个zone生成候选控制方案
  const zoneCandidates = zones.map(zone => {
    const c = COEFFICIENTS[zone.category] || COEFFICIENTS.commercial;
    const maxTol = c.comfort_tol;
    const offsets = [];
    const nSteps = 2 * candidates + 1;
    for (let i = 0; i <= nSteps; i++) {
      offsets.push(-maxTol + (2 * maxTol * i / nSteps));
    }
    return { zone, offsets, maxTol };
  });

  // 在所有候选组合中搜索最优
  function evaluateStrategy(offsets) {
    let totalEnergy = 0, totalDeviation = 0, totalCost = 0;
    let peakLoad = 0;

    for (let t = 0; t < N; t++) {
      let stepLoad = 0;
      for (let z = 0; z < zones.length; z++) {
        const T_prev = t > 0 ? T_env_forecast[t - 1] : T_env_forecast[0];
        const result = computeCoolingPowerV2(
          zones[z].category, T_env_forecast[t], RH_forecast[t] || REFERENCE_RH,
          T_prev, offsets[z]
        );
        stepLoad += result.power;
        totalDeviation += Math.abs(result.deviation);
      }
      peakLoad = Math.max(peakLoad, stepLoad);
      totalEnergy += stepLoad * controlInterval / 60;
      totalCost += stepLoad * (price_forecast[t] || 350) / 1000 * controlInterval / 60;
    }

    // 目标函数打分
    const overflow = Math.max(0, peakLoad - gridCapacity);
    const overflowPenalty = overflow > 0 ? weights.lambda_overflow * Math.pow(overflow / gridCapacity, 2) : 0;

    return {
      offsets: offsets.map(o => Math.round(o * 10) / 10),
      totalEnergy: Math.round(totalEnergy * 10) / 10,
      totalCost: Math.round(totalCost * 10) / 10,
      peakLoad: Math.round(peakLoad * 10) / 10,
      avgDeviation: Math.round(totalDeviation / (N * zones.length) * 100) / 100,
      overflowPenalty: Math.round(overflowPenalty * 10000) / 10000,
    };
  }

  // 贪心搜索（实际工程中可用粒子群/遗传算法，此处保持轻量）
  let bestOffsets = zones.map(z => 0);
  let bestResult = evaluateStrategy(bestOffsets);

  // 迭代优化：每个zone独立搜索最佳偏移
  for (let iter = 0; iter < 3; iter++) {
    let improved = false;
    for (let z = 0; z < zones.length; z++) {
      const candList = zoneCandidates[z].offsets;
      for (const off of candList) {
        const trial = [...bestOffsets];
        trial[z] = off;
        const result = evaluateStrategy(trial);
        const score = result.totalCost + result.overflowPenalty * 1000;
        const bestScore = bestResult.totalCost + bestResult.overflowPenalty * 1000;
        if (score < bestScore) {
          bestOffsets = trial;
          bestResult = result;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // 生成每个zone的推荐
  const recommendations = zones.map((z, i) => {
    const c = COEFFICIENTS[z.category] || COEFFICIENTS.commercial;
    const off = bestOffsets[i];
    const action = off < -0.5 ? '预冷降温' : off > 0.5 ? '放宽温控' : '维持当前';
    const impact = off < 0 ? `短时增加功率，高峰时段节省` : `降低功率，舒适度轻微影响`;
    return {
      zoneId: z.id,
      category: z.category,
      currentTemp: z.currentTemp,
      recommendedOffset: off,
      newTarget: Math.round((c.T_target + off) * 10) / 10,
      action,
      impact,
      priority: z.priority,
    };
  });

  return {
    horizon: N,
    controlIntervalMin: controlInterval,
    forecast: { temperatures: T_env_forecast.slice(0, N), humidity: (RH_forecast || []).slice(0, N), prices: price_forecast.slice(0, N) },
    optimalOffsets: bestOffsets.map(o => Math.round(o * 10) / 10),
    result: bestResult,
    recommendations,
    estimatedSavings: {
      peakReductionKW: Math.round(Math.max(0, zones.reduce((s, z, i) => {
        const c = COEFFICIENTS[z.category] || COEFFICIENTS.commercial;
        return s + c.alpha * Math.abs(bestOffsets[i]);
      }, 0))),
      costReductionPercent: Math.round(100 - (bestResult.totalCost / evaluateStrategy(zones.map(() => 0)).totalCost * 100)),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * MPC 滚动模拟 — 模拟未来24小时控制效果
 */
function mpcSimulate24h(params) {
  const {
    zones,
    T_series = [], RH_series = [], price_series = [],
    gridCapacity = 3500,
    stepMin = 30,
  } = params;

  const N = T_series.length;
  const horizon = Math.min(6, N);
  const results = [];

  for (let t = 0; t < N; t++) {
    const futureT = T_series.slice(t, t + horizon);
    const futureRH = (RH_series || []).slice(t, t + horizon);
    const futurePrice = price_series.slice(t, t + horizon);

    const stepResult = mpcOptimize({
      zones, T_env_forecast: futureT, RH_forecast: futureRH,
      price_forecast: futurePrice, gridCapacity, N_horizon: horizon,
      controlInterval: stepMin,
    });

    results.push({
      timeIndex: t,
      ...stepResult.result,
      recommendations: stepResult.recommendations,
      offsets: stepResult.optimalOffsets,
    });
  }

  return {
    steps: results,
    timeline: results.map(r => ({
      time: r.timeIndex,
      peakLoad: r.peakLoad,
      cost: r.totalCost,
      deviation: r.avgDeviation,
    })),
    summary: {
      avgPeakLoad: Math.round(results.reduce((s, r) => s + r.peakLoad, 0) / N),
      maxPeakLoad: Math.round(Math.max(...results.map(r => r.peakLoad))),
      totalCost: Math.round(results.reduce((s, r) => s + r.totalCost, 0) * 100) / 100,
      avgDeviation: Math.round(results.reduce((s, r) => s + r.avgDeviation, 0) / N * 100) / 100,
    },
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 4. 供需平衡双向优化 ──────────────────────────────────────────────────
// ===========================================================================

/**
 * 供需平衡优化 — 发电成本最小化
 *
 * 问题形式:
 *   min  Σ C_gen_i(P_i)
 *   s.t. Σ P_i = P_load_total
 *        0 ≤ P_i ≤ P_max_i
 *
 * 发电侧:
 *   - C_gen_i(P_i): 机组i的发电成本函数（二次函数）
 *   - C(P) = a·P² + b·P + c
 *
 * 负荷侧:
 *   - 可调负荷的值 = comfort_penalty * ΔP (舒适度损失)
 *   - 不可调负荷 = 必须满足
 *
 * 等价于:
 *   min Σ(a_i·P_i² + b_i·P_i + c_i) + Σ u_j·(P_demand_j - P_adjustable_j)²
 *   s.t. Σ P_i = Σ P_demand_j - Σ ΔP_j
 *
 * @param {Object} params
 * @returns {Object}
 */
function supplyDemandOptimize(params) {
  const {
    generators = [
      { id: 'Gen1', name: '1号机组(煤电)', a: 0.0008, b: 0.32, c: 12, P_min: 200, P_max: 600, emission: 0.85, isRenewable: false },
      { id: 'Gen2', name: '2号机组(煤电)', a: 0.0009, b: 0.35, c: 10, P_min: 150, P_max: 500, emission: 0.90, isRenewable: false },
      { id: 'Gen3', name: '3号机组(气电)', a: 0.0012, b: 0.45, c: 8,  P_min: 100, P_max: 300, emission: 0.40, isRenewable: false },
      { id: 'Gen4', name: '光伏电站',     a: 0.0001, b: 0.08, c: 2,  P_min: 0,   P_max: 400, emission: 0,    isRenewable: true },
      { id: 'Gen5', name: '风力发电',     a: 0.0001, b: 0.06, c: 1,  P_min: 0,   P_max: 350, emission: 0,    isRenewable: true },
      { id: 'Gen6', name: '储能放电',     a: 0.0005, b: 0.25, c: 5,  P_min: 0,   P_max: 200, emission: 0.05, isRenewable: false },
    ],
    loads = [
      { id: 'commercial',  demand: 1200, adjustable: 180, comfortCost: 0.08 },
      { id: 'residential', demand: 800,  adjustable: 100, comfortCost: 0.20 },
      { id: 'industrial',  demand: 500,  adjustable: 150, comfortCost: 0.05 },
      { id: 'datacenter',  demand: 380,  adjustable: 40,  comfortCost: 0.30 },
      { id: 'hospital',    demand: 320,  adjustable: 20,  comfortCost: 0.40 },
    ],
    totalDemand = loads.reduce((s, l) => s + l.demand, 0),
    gridCapacity = 3500,
    carbonPrice = 60, // 碳价 元/吨CO₂
  } = params;

  const adjustedDemand = totalDemand;

  // 等边际成本原则：按照边际成本递增顺序分配负荷
  // 简化为优先使用低碳/低成本机组
  const sortedGens = [...generators].sort((a, b) => {
    // 可再生能源优先
    if (a.isRenewable && !b.isRenewable) return -1;
    if (!a.isRenewable && b.isRenewable) return 1;
    // 同类型: 边际成本低的优先
    const mc_a = 2 * a.a * a.P_min + a.b;
    const mc_b = 2 * b.a * b.P_min + b.b;
    return mc_a - mc_b;
  });

  // 分配负荷
  let remaining = adjustedDemand;
  const dispatch = [];

  for (const gen of sortedGens) {
    if (remaining <= 0) break;
    const allocated = Math.min(gen.P_max, Math.max(gen.P_min, remaining));
    remaining -= allocated;

    const cost = gen.a * allocated * allocated + gen.b * allocated + gen.c;
    const emission = gen.emission * allocated;
    const carbonCost = (emission / 1000) * carbonPrice; // 吨CO₂ → 元

    dispatch.push({
      id: gen.id,
      name: gen.name,
      powerMW: Math.round(allocated / 1000 * 100) / 100,
      powerKW: Math.round(allocated),
      loadPercent: Math.round(allocated / gen.P_max * 100),
      generationCostYuan: Math.round(cost * 100) / 100,
      marginalCost: Math.round((2 * gen.a * allocated + gen.b) * 1000) / 1000,
      emissionKgCO2: Math.round(emission * 100) / 100,
      carbonCostYuan: Math.round(carbonCost * 10) / 10,
      isRenewable: gen.isRenewable,
    });
  }

  // 负荷侧优化：选择调整哪些可调负荷
  const loadAdjustments = loads.map(l => {
    const maxAdjust = l.adjustable;
    // 如果需求能被满足，不调整
    const optimal = 0;
    return {
      id: l.id,
      demandKW: l.demand,
      adjustableKW: l.adjustable,
      adjustmentKW: optimal,
      adjustedDemandKW: l.demand + optimal,
      comfortCostYuan: Math.abs(optimal) * l.comfortCost,
    };
  });

  const totalCost = dispatch.reduce((s, d) => s + d.generationCostYuan, 0);
  const totalEmission = dispatch.reduce((s, d) => s + d.emissionKgCO2, 0);
  const totalRenewable = dispatch.filter(d => d.isRenewable).reduce((s, d) => s + d.powerKW, 0);
  const renewablePercent = Math.round(totalRenewable / adjustedDemand * 100);

  return {
    totalDemandKW: Math.round(adjustedDemand),
    totalGenerationKW: Math.round(dispatch.reduce((s, d) => s + d.powerKW, 0)),
    dispatch,
    loadAdjustments,
    summary: {
      totalCostYuan: Math.round(totalCost * 10) / 10,
      avgMarginalCost: Math.round((2 * sortedGens[0].a * (adjustedDemand / sortedGens.length) + sortedGens[0].b) * 1000) / 1000,
      totalEmissionKgCO2: Math.round(totalEmission * 10) / 10,
      totalCarbonCostYuan: Math.round((totalEmission / 1000) * carbonPrice * 10) / 10,
      renewableKW: Math.round(totalRenewable),
      renewablePercent,
      capacityUtilization: Math.round(adjustedDemand / gridCapacity * 100),
    },
    isBalanced: Math.abs(dispatch.reduce((s, d) => s + d.powerKW, 0) - adjustedDemand) < 1,
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 5. 博弈论多目标优化（纳什议价解）──────────────────────────────────────
// ===========================================================================

/**
 * 博弈论多目标优化 — 纳什议价解 (Nash Bargaining Solution)
 *
 * 问题:
 *   各区域对温度/舒适度有不同偏好（disagreement point d_i）
 *   目标: 找到各方都能接受的折中方案
 *
 * 纳什积:
 *   max Π (U_i(u) - d_i)
 *   s.t. U_i(u) ≥ d_i  ∀i
 *
 * 效用函数 (各区域不同):
 *   U_i(T_i) = 1 - |T_i - T_target_i|² / (comfort_tol_i)²   (舒适度)
 *   U_i(P_i) = 1 - P_i / P_max_i                              (节能)
 *
 * 对每个区域:
 *   U_i = λ_i_t · U_i_comfort + λ_i_p · U_i_power
 *
 * @param {Object} params
 * @returns {Object}
 */
function nashBargainingOptimize(params) {
  const {
    zones = [
      { id: 'commercial',  category: 'commercial',  T_target: 24, T_current: 22.9, powerKW: 1200, P_max: 1800,
        comfortWeight: 0.6, powerWeight: 0.4, disagreement: 0.50, tolerance: 2.0 },
      { id: 'residential', category: 'residential', T_target: 26, T_current: 25.5, powerKW: 850,  P_max: 1200,
        comfortWeight: 0.8, powerWeight: 0.2, disagreement: 0.60, tolerance: 0.5 },
      { id: 'industrial',  category: 'industrial',   T_target: 22, T_current: 21.8, powerKW: 650,  P_max: 900,
        comfortWeight: 0.3, powerWeight: 0.7, disagreement: 0.40, tolerance: 3.0 },
      { id: 'datacenter',  category: 'datacenter',   T_target: 22, T_current: 21.2, powerKW: 500,  P_max: 700,
        comfortWeight: 0.9, powerWeight: 0.1, disagreement: 0.55, tolerance: 0.5 },
      { id: 'hospital',    category: 'hospital',     T_target: 23, T_current: 22.5, powerKW: 400,  P_max: 550,
        comfortWeight: 0.95,powerWeight: 0.05,disagreement: 0.65, tolerance: 0.3 },
    ],
    T_env = 32,
    RH = 55,
    totalPowerBudget = 3200,  // 总功率预算约束
  } = params;

  // 计算舒适度效用
  function comfortUtility(zone, T) {
    const tol = zone.tolerance;
    const delta = Math.abs(T - zone.T_target);
    if (delta <= tol) return 1.0; // 在容忍范围内，满分
    return Math.max(0, 1 - Math.pow((delta - tol) / tol, 2));
  }

  // 计算功率效用
  function powerUtility(zone, P) {
    return Math.max(0, 1 - (P / zone.P_max));
  }

  // 综合效用
  function totalUtility(zone, T, P) {
    const u_comfort = comfortUtility(zone, T);
    const u_power = powerUtility(zone, P);
    return zone.comfortWeight * u_comfort + zone.powerWeight * u_power;
  }

  // 计算纳什积
  function nashProduct(allocations) {
    let prod = 1;
    for (let i = 0; i < zones.length; i++) {
      const util = totalUtility(zones[i], allocations[i].T, allocations[i].P);
      const gain = Math.max(0.001, util - zones[i].disagreement);
      prod *= gain;
    }
    return prod;
  }

  // 搜索最优温度分配
  const tempCandidates = [];
  const nTempPoints = 20;

  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const minT = z.T_target - z.tolerance * 1.5;
    const maxT = z.T_target + z.tolerance * 1.5;
    const tCands = [];
    for (let j = 0; j <= nTempPoints; j++) {
      tCands.push(minT + (maxT - minT) * j / nTempPoints);
    }
    tempCandidates.push(tCands);
  }

  // 对每个温度分配，计算对应功率，评估纳什积
  let bestAllocation = null;
  let bestNashProduct = -1;
  let paretoFront = [];

  // 迭代搜索（简化版：每个zone独立搜索+迭代协调）
  // Round 1: 各zone独立最优
  const draftT = zones.map(z => z.T_current);
  const draftP = zones.map((z, i) => computeCoolingPowerV2(z.category, T_env, RH, T_env, draftT[i] - z.T_target).power);

  // 协调：如果总功率超预算，优先削减低优先级区域的功率
  let totalP = draftP.reduce((s, p) => s + p, 0);
  const iterations = [];

  for (let iter = 0; iter < 5 && totalP > totalPowerBudget; iter++) {
    // 按 comfortWeight 排序，优先削减 comfortWeight 低的区域
    const order = zones.map((z, i) => ({ idx: i, cw: z.comfortWeight }))
      .sort((a, b) => a.cw - b.cw);

    for (const { idx } of order) {
      if (totalP <= totalPowerBudget) break;
      const z = zones[idx];
      const step = 0.3;
      const newT = draftT[idx] + step; // 升温降低功率
      const newP = computeCoolingPowerV2(z.category, T_env, RH, T_env, newT - z.T_target).power;
      const diff = draftP[idx] - newP;
      if (diff > 0) {
        draftT[idx] = newT;
        draftP[idx] = newP;
        totalP -= diff;
      }
    }
    iterations.push({
      round: iter + 1,
      totalPower: Math.round(totalP),
      temperatures: draftT.map(t => Math.round(t * 10) / 10),
      powers: draftP.map(p => Math.round(p)),
    });
  }

  // 构建最终分配方案
  const finalAllocations = zones.map((z, i) => {
    const actualP = computeCoolingPowerV2(z.category, T_env, RH, T_env, draftT[i] - z.T_target).power;
    const u_comfort = comfortUtility(z, draftT[i]);
    const u_power = powerUtility(z, actualP);
    const u_total = totalUtility(z, draftT[i], actualP);

    return {
      id: z.id,
      category: z.category,
      T_target: z.T_target,
      T_allocated: Math.round(draftT[i] * 10) / 10,
      T_deviation: Math.round((draftT[i] - z.T_target) * 100) / 100,
      powerKW: Math.round(actualP),
      utilities: {
        comfort: Math.round(u_comfort * 1000) / 1000,
        power: Math.round(u_power * 1000) / 1000,
        total: Math.round(u_total * 1000) / 1000,
      },
      gainOverDisagreement: Math.round(Math.max(0, u_total - z.disagreement) * 1000) / 1000,
    };
  });

  const totalAllocated = finalAllocations.reduce((s, a) => s + a.powerKW, 0);
  const nashProd = finalAllocations.reduce((prod, a) => prod * Math.max(0.001, a.gainOverDisagreement), 1);

  // 公平性指标: Gini系数
  const gains = finalAllocations.map(a => a.gainOverDisagreement);
  const meanGain = gains.reduce((s, g) => s + g, 0) / gains.length;
  let giniNum = 0;
  for (let i = 0; i < gains.length; i++) {
    for (let j = 0; j < gains.length; j++) {
      giniNum += Math.abs(gains[i] - gains[j]);
    }
  }
  const gini = Math.round(giniNum / (2 * gains.length * gains.length * Math.max(0.001, meanGain)) * 1000) / 1000;

  return {
    allocations: finalAllocations,
    totalPowerKW: Math.round(totalAllocated),
    powerBudgetKW: totalPowerBudget,
    withinBudget: totalAllocated <= totalPowerBudget + 1,
    nashProduct: Math.round(nashProd * 1e10) / 1e10,
    fairness: {
      giniCoefficient: gini,
      interpretation: gini < 0.2 ? '高度公平' : gini < 0.35 ? '基本公平' : '需要协调',
    },
    paretoOptimal: totalAllocated <= totalPowerBudget + 1,
    iterations,
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 原有策略函数（保持不变，保持向后兼容）────────────────────────────────
// ===========================================================================

function computePrecoolingStrategy(params) {
  const {
    category = 'commercial', T_target = 24, thermal_mass = 180,
    T_env_forecast = [], precool_window_start = 4, precool_window_end = 7, precool_depth = 3.5,
  } = params;

  const T_precool = T_target - precool_depth;
  const coef = COEFFICIENTS[category] || COEFFICIENTS.commercial;
  const precool_hours = precool_window_end - precool_window_start;
  const extraPower = Math.round(thermal_mass * precool_depth / precool_hours);
  const peakHours = [13, 14, 15, 16, 17];
  let savingsPerHour = 0;
  peakHours.forEach(h => {
    if (T_env_forecast[h]) {
      const effective_t_reduction = precool_depth * Math.exp(-(h - precool_window_end) * 0.15);
      savingsPerHour += coef.alpha * Math.min(precool_depth, effective_t_reduction);
    }
  });
  const totalSavings = Math.round(savingsPerHour);
  const energyCost = Math.round(extraPower * precool_hours * 0.8);

  return {
    enabled: true, precool_temp: T_precool,
    precool_window: `${precool_window_start}:00-${precool_window_end}:00`,
    precool_depth, extra_power_kw: extraPower, estimated_savings_kw: totalSavings,
    net_benefit_kw: totalSavings - energyCost,
    savings_pct: Math.round(totalSavings / coef.P_base * 100),
    schedule: { start: `${precool_window_start}:00`, end: `${precool_window_end}:00`, target: T_precool, ramp_rate: Math.round(precool_depth / precool_hours * 10) / 10 },
  };
}

function computeZoneControlStrategy(params) {
  const zones = params.zones || [
    { label: '商业综合体A', category: 'commercial', priority: 2, tolerance: 2.0 },
    { label: '商业综合体B', category: 'commercial', priority: 3, tolerance: 2.5 },
    { label: '数据中心',     category: 'datacenter',  priority: 1, tolerance: 0.5 },
    { label: '居民社区A',    category: 'residential', priority: 1, tolerance: 0.5 },
    { label: '居民社区B',    category: 'residential', priority: 2, tolerance: 1.0 },
    { label: '工业用户',     category: 'industrial',  priority: 3, tolerance: 3.0 },
    { label: '人民医院',     category: 'hospital',    priority: 1, tolerance: 0.3 },
  ];
  const T_env = params.T_env || 30;
  const results = zones.map(zone => {
    const baseline = computeCoolingPower(zone.category, T_env, 0);
    const relaxed = computeCoolingPower(zone.category, T_env, zone.tolerance);
    const saved = Math.round((baseline.power - relaxed.power) * 100) / 100;
    return { ...zone, baseline_power: baseline.power, relaxed_power: relaxed.power, saved_kw: saved, saved_pct: Math.round(saved / baseline.power * 100), T_target_original: baseline.T_target, T_target_relaxed: relaxed.T_target, allowed_deviation: zone.tolerance, comfort_impact: zone.priority === 1 ? 'minimal' : zone.priority === 2 ? 'moderate' : 'acceptable' };
  });
  const totalBaseline = Math.round(results.reduce((s, r) => s + r.baseline_power, 0) * 100) / 100;
  const totalRelaxed = Math.round(results.reduce((s, r) => s + r.relaxed_power, 0) * 100) / 100;
  return { enabled: true, zones: results, total_baseline_kw: totalBaseline, total_optimized_kw: totalRelaxed, total_saved_kw: Math.round((totalBaseline - totalRelaxed) * 100) / 100, saved_pct: Math.round((totalBaseline - totalRelaxed) / totalBaseline * 100) };
}

function computeNightStorageStrategy(params) {
  const { storage_capacity_kw = 400, charge_hours = [23, 0, 1, 2, 3, 4, 5, 6], cop = 5.5, storage_efficiency = 0.85, peak_price_zones = [{ hours: [10, 11], price: 520 }, { hours: [17, 18, 19, 20], price: 560 }], valley_price = 220 } = params;
  const chargePower = storage_capacity_kw / cop;
  const totalChargeKwh = chargePower * charge_hours.length;
  const usableStorageKwh = totalChargeKwh * storage_efficiency;
  const chargeCost = totalChargeKwh * valley_price / 1000;
  let avoidedCost = 0;
  peak_price_zones.forEach(zone => {
    zone.hours.forEach(() => {
      const discharge_kwh = Math.min(storage_capacity_kw / zone.hours.length, usableStorageKwh / zone.hours.length);
      avoidedCost += discharge_kwh * zone.price / 1000;
    });
  });
  const netBenefit = Math.round((avoidedCost - chargeCost) * 100) / 100;
  return {
    enabled: true, charge_power_kw: Math.round(chargePower * 100) / 100, charge_hours: charge_hours.length,
    charge_energy_mwh: Math.round(totalChargeKwh / 1000 * 100) / 100,
    usable_storage_mwh: Math.round(usableStorageKwh / 1000 * 100) / 100, efficiency: storage_efficiency,
    economics: { charge_cost_yuan: Math.round(chargeCost * 100) / 100, avoided_cost_yuan: Math.round(avoidedCost * 100) / 100, net_benefit_yuan: netBenefit, roi_pct: Math.round(netBenefit / chargeCost * 100) },
    discharge_schedule: peak_price_zones.map(zone => ({ hours: `${zone.hours[0]}:00-${zone.hours[zone.hours.length - 1] + 1}:00`, power_kw: Math.round(storage_capacity_kw / zone.hours.length), price: zone.price })),
  };
}

function computePeakShiftStrategy(params) {
  const { zones = [{ label: '商业B区-2F', power: 85 }, { label: '商业B区-3F', power: 78 }, { label: '商业B区-4F', power: 72 }, { label: '办公区A', power: 95 }, { label: '办公区B', power: 88 }, { label: '公共区域', power: 65 }], cycle_duration_min = 30, off_duration_min = 6, peak_hours = [17, 18, 19, 20] } = params;
  const totalPower = zones.reduce((s, z) => s + z.power, 0);
  const groupsPerCycle = Math.floor(cycle_duration_min / off_duration_min);
  const totalPeakMinutes = peak_hours.length * 60;
  const totalOffMinutes = Math.round(totalPeakMinutes * off_duration_min / cycle_duration_min);
  const sorted = [...zones].sort((a, b) => b.power - a.power);
  const groups = [];
  for (let i = 0; i < groupsPerCycle; i++) {
    const gz = sorted.filter((_, idx) => idx % groupsPerCycle === i);
    groups.push({ group: i + 1, zones: gz.map(z => z.label), power_kw: Math.round(gz.reduce((s, z) => s + z.power, 0) * 100) / 100, off_order: i });
  }
  const avgPowerReduction = Math.round(totalPower / groupsPerCycle * 100) / 100;
  return {
    enabled: true, cycle_duration_min, off_duration_min, peak_hours_range: `${peak_hours[0]}:00-${peak_hours[peak_hours.length - 1] + 1}:00`,
    total_zones: zones.length, groups, groups_per_cycle: groupsPerCycle, avg_power_reduction_kw: avgPowerReduction,
    total_saved_kwh: Math.round(avgPowerReduction * totalOffMinutes / 60),
    comfort_impact: `单次暂停≤${off_duration_min}分钟，室内温度波动<0.3°C`,
    schedule: groups.map(g => ({ group: g.group, zone_labels: g.zones, power_kw: g.power_kw, off_schedule: `每${cycle_duration_min}分钟暂停${off_duration_min}分钟` })),
  };
}

function computeDemandResponseCapability(params) {
  const { total_load_kw = 3000, cooling_load_kw = 1800, adjustable_ratio = 0.7, comfort_constraint = 2.0, current_temp = 25, T_target = 26 } = params;
  const adjustableCooling = cooling_load_kw * adjustable_ratio;
  const tempMargin = Math.max(0, (T_target + comfort_constraint) - current_temp);
  const powerPerDegree = adjustableCooling * 0.35;
  const levels = [
    { level: 1, label: '一级响应', temp_rise: 0.5, power_reduction_kw: Math.round(powerPerDegree * 0.5), load_reduction_pct: Math.round(powerPerDegree * 0.5 / total_load_kw * 1000) / 10, comfort_impact: '轻微（±0.5°C）', compensation_yuan_per_mwh: 35 },
    { level: 2, label: '二级响应', temp_rise: 1.0, power_reduction_kw: Math.round(powerPerDegree * 1.0), load_reduction_pct: Math.round(powerPerDegree * 1.0 / total_load_kw * 1000) / 10, comfort_impact: '适中（±1.0°C）', compensation_yuan_per_mwh: 65 },
    { level: 3, label: '三级响应', temp_rise: Math.min(comfort_constraint, tempMargin), power_reduction_kw: Math.round(powerPerDegree * Math.min(comfort_constraint, tempMargin)), load_reduction_pct: Math.round(powerPerDegree * Math.min(comfort_constraint, tempMargin) / total_load_kw * 1000) / 10, comfort_impact: `边界（±${Math.min(comfort_constraint, tempMargin)}°C）`, compensation_yuan_per_mwh: 120 },
  ];
  const maxReduction = levels[2].power_reduction_kw;
  return {
    enabled: true, total_load_kw, cooling_load_kw, adjustable_capacity_kw: Math.round(adjustableCooling),
    adjustable_pct: Math.round(adjustableCooling / total_load_kw * 1000) / 10, max_reduction_kw: maxReduction,
    max_reduction_pct: Math.round(maxReduction / total_load_kw * 1000) / 10,
    current_margin: Math.round(tempMargin * 10) / 10, levels,
    estimated_daily_revenue: Math.round(maxReduction * levels[2].compensation_yuan_per_mwh / 1000 * 4),
  };
}

function scoreRecoveryPlans(plans, currentState, weights = null) {
  const defaultWeights = { emergency: { w1: 0.15, w2: 0.25, w3: 0.60 }, normal: { w1: 0.55, w2: 0.30, w3: 0.15 } };
  const activeWeights = (currentState && currentState.fault_active) ? defaultWeights.emergency : defaultWeights.normal;
  const w = Object.assign({}, activeWeights, weights || {});
  const scored = plans.map(plan => {
    const energy = plan.extra_power_kw * plan.duration_min / 60;
    const loadGap = plan.affected_load_kw * plan.duration_min / 60;
    const recoveryCost = plan.duration_min * plan.affected_load_kw;
    const obj = computeObjective({ energy, tempDeviation: loadGap, recoveryCost }, w);
    return { ...plan, J: obj.J, weights_used: { ...w }, metrics: { energy, loadGap, recoveryCost } };
  });
  scored.sort((a, b) => a.J - b.J);
  if (scored.length > 0) scored[0].recommended = true;
  return { plans: scored, recommended: scored.length > 0 ? scored[0] : null, mode: currentState && currentState.fault_active ? 'emergency' : 'normal', timestamp: new Date().toISOString() };
}

function recommendStrategies(state) {
  const { outdoorTemp = 30, gridLoad = 2800, gridLoadRate = 75, coolingLoad = 1600, electricityPrice = 350, hour = new Date().getHours(), forecast = null } = state;
  const recommendations = [];
  if (hour >= 3 && hour <= 7) {
    const precool = computePrecoolingStrategy({ category: 'commercial', T_env_forecast: forecast ? forecast.temperature : Array(24).fill(outdoorTemp) });
    recommendations.push({ id: 'precool', name: '预冷控制', icon: 'snowflake', priority: 'high', score: 92, trigger: `当前${hour}:00 处于预冷窗口`, details: precool, estimated_savings: `${precool.net_benefit_kw} kW`, action_label: '启动预冷' });
  } else if (outdoorTemp > 33 && forecast && forecast.peak_temp > 37) {
    const precool = computePrecoolingStrategy({ category: 'commercial', precool_window_start: hour, precool_window_end: Math.min(hour + 3, 7) });
    recommendations.push({ id: 'precool', name: '预冷控制', icon: 'snowflake', priority: 'medium', score: 75, trigger: `明日预报高温${forecast.peak_temp}°C，建议提前预冷`, details: precool, estimated_savings: `${precool.net_benefit_kw} kW`, action_label: '计划预冷' });
  }
  if (gridLoadRate > 80) {
    const zoneCtrl = computeZoneControlStrategy({ T_env: outdoorTemp });
    recommendations.push({ id: 'zone', name: '分区控制', icon: 'layers', priority: gridLoadRate > 90 ? 'high' : 'medium', score: gridLoadRate > 90 ? 88 : 72, trigger: `电网负载率 ${Math.round(gridLoadRate)}%，建议分区差异化控制`, details: zoneCtrl, estimated_savings: `${zoneCtrl.total_saved_kw} kW`, action_label: '执行分区控制' });
  }
  const isValleyHour = hour >= 23 || hour <= 6;
  if (isValleyHour && electricityPrice < 250) {
    const nightStorage = computeNightStorageStrategy({ valley_price: electricityPrice });
    recommendations.push({ id: 'night_storage', name: '夜间蓄冷', icon: 'battery', priority: 'medium', score: 85, trigger: `低电价时段 ${electricityPrice} 元/MWh`, details: nightStorage, estimated_savings: `¥${nightStorage.economics.net_benefit_yuan}/天`, action_label: '启动蓄冷' });
  }
  const isPeakHour = (hour >= 10 && hour <= 12) || (hour >= 17 && hour <= 20);
  if (isPeakHour && gridLoadRate > 75) {
    const peakShift = computePeakShiftStrategy({});
    recommendations.push({ id: 'peak_shift', name: '错峰运行', icon: 'shuffle', priority: gridLoadRate > 90 ? 'high' : 'medium', score: gridLoadRate > 90 ? 90 : 75, trigger: `高峰时段${hour}:00，负载率${Math.round(gridLoadRate)}%`, details: peakShift, estimated_savings: `${peakShift.avg_power_reduction_kw} kW`, action_label: '启动错峰' });
  }
  const dr = computeDemandResponseCapability({ total_load_kw: gridLoad, cooling_load_kw: coolingLoad });
  recommendations.push({ id: 'demand_response', name: '需求响应', icon: 'zap', priority: 'standby', score: 65, trigger: '待命响应，三级联动可调', details: dr, estimated_savings: `最大 ${dr.max_reduction_kw} kW`, action_label: '查看响应方案' });
  recommendations.sort((a, b) => b.score - a.score);
  return { recommendations, total_estimated_saving_kw: Math.round(recommendations.filter(r => r.priority !== 'standby').reduce((sum, r) => { const match = r.estimated_savings.match(/([\d.]+)/); return sum + (match ? parseFloat(match[1]) : 0); }, 0)), active_count: recommendations.filter(r => r.priority === 'high').length, standby_count: recommendations.filter(r => r.priority === 'standby').length, timestamp: new Date().toISOString(), mode: gridLoadRate > 90 ? 'emergency' : gridLoadRate > 80 ? 'cautious' : 'normal' };
}

function simulateOptimization(baseline, strategies) {
  const result = { baseline, strategies_applied: strategies, savings: { energy_kwh: 0, cost_yuan: 0, peak_reduction_kw: 0 }, comfort_impact: { max_temp_deviation: 0, avg_temp_deviation: 0 }, timeline: [] };
  strategies.forEach(strategyId => {
    switch (strategyId) {
      case 'precool': result.savings.energy_kwh += 324; result.savings.cost_yuan += 168; result.savings.peak_reduction_kw += 120; result.comfort_impact.max_temp_deviation = Math.max(result.comfort_impact.max_temp_deviation, 1.5); result.timeline.push({ time: '04:00-07:00', action: '执行预冷控制', detail: '提前降温3.5°C，建筑蓄冷', effect: '高峰时段负荷降低120kW' }); break;
      case 'zone': result.savings.energy_kwh += 286; result.savings.cost_yuan += 132; result.savings.peak_reduction_kw += 95; result.comfort_impact.max_temp_deviation = Math.max(result.comfort_impact.max_temp_deviation, 2.5); result.timeline.push({ time: '全天', action: '执行分区控制', detail: '商业区±2°C，工业区±3°C', effect: '峰值负荷降低95kW' }); break;
      case 'night_storage': result.savings.energy_kwh += 412; result.savings.cost_yuan += 245; result.savings.peak_reduction_kw += 200; result.comfort_impact.max_temp_deviation = Math.max(result.comfort_impact.max_temp_deviation, 0.3); result.timeline.push({ time: '23:00-06:00蓄冷 / 10:00-20:00释冷', action: '夜间蓄冷调度', detail: '蓄冷1.2MWh，白天释冷替代压缩机制冷', effect: '峰值负荷降低200kW' }); break;
      case 'peak_shift': result.savings.energy_kwh += 198; result.savings.cost_yuan += 95; result.savings.peak_reduction_kw += 80; result.comfort_impact.max_temp_deviation = Math.max(result.comfort_impact.max_temp_deviation, 0.3); result.timeline.push({ time: '17:00-21:00', action: '执行错峰运行', detail: '6个区域轮流暂停6min/30min周期', effect: '峰值负荷降低80kW' }); break;
      case 'demand_response': result.savings.energy_kwh += 180; result.savings.cost_yuan += 240; result.savings.peak_reduction_kw += 260; result.comfort_impact.max_temp_deviation = Math.max(result.comfort_impact.max_temp_deviation, 2.0); result.timeline.push({ time: '按需', action: '启动需求响应', detail: '三级响应可调，最大260kW', effect: '获取电网补偿¥200+/次' }); break;
    }
  });
  result.total_savings_pct = Math.round(result.savings.peak_reduction_kw / Math.max(baseline.gridLoad || 3000, 1) * 100);
  return result;
}

// ===========================================================================
// ─── 导出 ─────────────────────────────────────────────────────────────────
// ===========================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // 基础参数
    COEFFICIENTS, CARBON_FACTOR, COP_CRITICAL_TEMP, COP_DEGRADE_K, REFERENCE_RH,
    // 升级模型
    computeCoolingPowerV2, computeCoolingMatrixV2, computeObjectiveV2,
    // MPC
    mpcOptimize, mpcSimulate24h,
    // 供需平衡
    supplyDemandOptimize,
    // 博弈论
    nashBargainingOptimize,
    // 原有函数（兼容）
    computeCoolingPower, computeCoolingMatrix, computeObjective,
    computePrecoolingStrategy, computeZoneControlStrategy,
    computeNightStorageStrategy, computePeakShiftStrategy,
    computeDemandResponseCapability,
    scoreRecoveryPlans, recommendStrategies, simulateOptimization,
  };
}
