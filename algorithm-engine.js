/**
 * ===========================================================================
 * 阶序智调 — 优化算法引擎 v3.0
 * ===========================================================================
 *
 * 基于论文《计及温控负荷多运行状态的主动配电网故障恢复策略》建模公式：
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 式(1)  空调等效热参数(ETP)模型                                       │
 * │        C·dT_in/dt = (T_out - T_in)/R - s·η·P_rated                  │
 * │                                                                      │
 * │ 式(2)  正常运行开机时间                                              │
 * │        t_on = R·C·ln[(T_out-ηPR-T_max)/(T_out-ηPR-T_min)]          │
 * │                                                                      │
 * │ 式(3)  正常运行停机时间                                              │
 * │        t_off = R·C·ln[(T_out-T_min)/(T_out-T_max)]                 │
 * │                                                                      │
 * │ 式(4)  计及回流功率的恢复阶段开机时间                                │
 * │        t_on_rec = R·C·ln[(T_out-ηPR-T_max)/(T_out-ηPR-T_rec)]      │
 * │        其中 T_rec > T_max (故障期间室温超调)                         │
 * │                                                                      │
 * │ 式(5)  空调聚合功率模型                                              │
 * │        P_agg(t) = Σ s_i(t)·P_rated_i·[1+δ_reflow_i(t)]             │
 * │                                                                      │
 * │ 式(6)  蓄热式电采暖热动态模型                                        │
 * │        C·dT/dt = (T_out-T_in)/R + P_heat+P_charge-P_discharge       │
 * │                                                                      │
 * │ 式(7)  PMV舒适温度模型                                               │
 * │        T_comfort = f(PMV, clothing, activity, RH, v_air)            │
 * │                                                                      │
 * │ 式(8)  综合目标函数                                                  │
 * │        max J = Σω_i(t)·R_i(t) - Σλ_j·C_j(t)                        │
 * │                                                                      │
 * │ 式(9)  负荷恢复收益函数                                              │
 * │        R_i(t) = ω_i(t)·P_i(t)·Δt                                    │
 * │                                                                      │
 * │ 式(10) 开关动作代价函数                                              │
 * │        C_j(t) = λ_j·|S_j(t) - S_j(t-1)|                             │
 * │                                                                      │
 * │ 式(11) 空调温度状态特征量（动态权重）                                │
 * │        ω_i(t) = ω_base + κ_T·(T_in_i - T_min_i)/(T_max_i-T_min_i)  │
 * │                                                                      │
 * │ 式(12) 蓄热状态特征量（动态权重）                                    │
 * │        ω_i(t) = ω_base + κ_S·(SOC_max - SOC_i)/(SOC_max-SOC_min)   │
 * └──────────────────────────────────────────────────────────────────────┘
 */

// ===========================================================================
// ─── 基础参数库 ───────────────────────────────────────────────────────────
// ===========================================================================

/**
 * 各区域 ETP 模型参数（单台空调）
 * R: 等效热阻 (°C/kW) — 单台建筑围护结构热阻
 * C: 等效热容 (kWh/°C) — 单台建筑热容
 * eta: 制冷效率 (COP) — 制冷量/电功率
 * P_rated: 单台额定电功率 (kW)
 * T_target: 设定温度 (°C)
 * delta: 温度死区宽度 (°C)，T_max = T_target + delta/2, T_min = T_target - delta/2
 * N_units: 该区域空调数量
 * zone_power: 区域总额定功率 (kW) — 用于聚合展示
 *
 * 参数校验: R·eta·P > (T_out_max - T_min) 确保空调能降温至T_min
 */
const ETP_PARAMS = {
  commercial:  { R: 1.0, C: 2.0, eta: 3.5, P_rated: 4.0, T_target: 24.0, delta: 2.0, N_units: 300, zone_power: 1200, comfort_tol: 2.0, priority: 2 },
  residential: { R: 1.2, C: 1.5, eta: 3.0, P_rated: 2.8, T_target: 26.0, delta: 1.0, N_units: 304, zone_power: 850,  comfort_tol: 0.5, priority: 1 },
  industrial:  { R: 0.8, C: 3.0, eta: 3.2, P_rated: 6.0, T_target: 22.0, delta: 4.0, N_units: 108, zone_power: 650,  comfort_tol: 3.0, priority: 3 },
  datacenter:  { R: 0.6, C: 1.0, eta: 3.5, P_rated: 8.0, T_target: 22.0, delta: 1.0, N_units: 63,  zone_power: 500,  comfort_tol: 0.5, priority: 1 },
  hospital:    { R: 0.9, C: 1.8, eta: 3.3, P_rated: 5.0, T_target: 23.0, delta: 0.6, N_units: 80,  zone_power: 400,  comfort_tol: 0.3, priority: 1 },
};

const CARBON_FACTOR = 0.42;     // kgCO2/kWh
const PMV_NEUTRAL = 0;          // PMV中性值
const PMV_COMFORT_RANGE = 0.5;  // PMV舒适范围 ±0.5

// ===========================================================================
// ─── 式(1) 空调等效热参数(ETP)模型 ────────────────────────────────────────
// ===========================================================================

/**
 * ETP 模型 — 室内温度动态方程
 *
 * 式(1): C·dT_in/dt = (T_out - T_in)/R - s·η·P_rated
 *
 * 解析解:
 *   AC开启(s=1): T_in(t) = T_ss_on + (T_in(0) - T_ss_on)·e^(-t/(R·C))
 *     其中 T_ss_on = T_out - R·η·P_rated (开启时稳态温度)
 *
 *   AC关闭(s=0): T_in(t) = T_out + (T_in(0) - T_out)·e^(-t/(R·C))
 *     其中 T_ss_off = T_out (关闭时稳态温度)
 *
 * @param {string} category  区域类型
 * @param {number} T_in0     初始室内温度 (°C)
 * @param {number} T_out     室外温度 (°C)
 * @param {number} dt        时间步长 (min)
 * @param {number} s         空调开停状态 (1=开, 0=停)
 * @returns {Object} 温度演化结果
 */
function etpModel(category, T_in0, T_out, dt_min, s) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const R = p.R, C = p.C, eta = p.eta, P = p.P_rated;
  const dt_h = dt_min / 60; // 转小时

  // 时间常数 τ = R·C (小时)
  const tau = R * C;

  // 稳态温度
  const T_ss = s === 1 ? (T_out - R * eta * P) : T_out;

  // 解析解: T_in(t) = T_ss + (T_in0 - T_ss)·e^(-t/τ)
  const T_in_new = T_ss + (T_in0 - T_ss) * Math.exp(-dt_h / tau);

  // 温度变化率
  const dT_dt = (T_in_new - T_in0) / dt_h;

  // 当前时刻制冷功率 (仅开启时)
  const coolingPower = s === 1 ? eta * P : 0;
  const electricPower = s === 1 ? P : 0;

  // 热交换量
  const heatInflow = (T_out - T_in0) / R * dt_h;
  const heatRemoval = s === 1 ? eta * P * dt_h : 0;

  return {
    T_in: Math.round(T_in_new * 100) / 100,
    T_in_prev: T_in0,
    T_out,
    T_ss: Math.round(T_ss * 100) / 100,
    tau: Math.round(tau * 100) / 100,
    s,
    dT_dt: Math.round(dT_dt * 1000) / 1000,
    coolingPower: Math.round(coolingPower * 100) / 100,
    electricPower: Math.round(electricPower * 100) / 100,
    heatInflow: Math.round(heatInflow * 100) / 100,
    heatRemoval: Math.round(heatRemoval * 100) / 100,
    category,
    params: { R, C, eta, P_rated: P, T_target: p.T_target, delta: p.delta },
  };
}

// ===========================================================================
// ─── 式(2)(3) 正常运行开/停机时间 ──────────────────────────────────────────
// ===========================================================================

/**
 * 式(2): 正常运行开机时间
 *   t_on = R·C·ln[(T_out - ηPR - T_min) / (T_out - ηPR - T_max)]
 *
 * AC开启时，室温从 T_max 下降到 T_min 所需时间
 *
 * @param {string} category  区域类型
 * @param {number} T_out     室外温度 (°C)
 * @returns {Object} 开机时间及参数
 */
function computeOnTime(category, T_out) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const R = p.R, C = p.C, eta = p.eta, P = p.P_rated;
  const T_target = p.T_target;
  const T_max = T_target + p.delta / 2;
  const T_min = T_target - p.delta / 2;

  // 开启时稳态温度
  const T_ss_on = T_out - R * eta * P;

  // 式(2): t_on = R·C·ln[(T_max - T_ss_on) / (T_min - T_ss_on)]
  // 温度从 T_max 下降到 T_min，T_ss_on < T_min < T_max
  const T_max_minus_ss = T_max - T_ss_on;  // > 0
  const T_min_minus_ss = T_min - T_ss_on;  // > 0

  // 防止对数定义域错误
  if (T_max_minus_ss <= 0 || T_min_minus_ss <= 0 || T_max_minus_ss <= T_min_minus_ss) {
    return {
      t_on: Infinity,
      t_on_min: Infinity,
      T_max, T_min, T_ss_on: Math.round(T_ss_on * 100) / 100,
      formula: 't_on = R·C·ln[(T_max-T_ss)/(T_min-T_ss)]',
      note: '空调容量不足，无法降温至T_min',
      category,
    };
  }

  const t_on = R * C * Math.log(T_max_minus_ss / T_min_minus_ss);

  return {
    t_on: Math.round(t_on * 100) / 100,
    t_on_min: Math.round(t_on * 60 * 10) / 10,
    T_max, T_min, T_ss_on: Math.round(T_ss_on * 100) / 100,
    T_max_minus_ss: Math.round(T_max_minus_ss * 100) / 100,
    T_min_minus_ss: Math.round(T_min_minus_ss * 100) / 100,
    formula: 't_on = R·C·ln[(T_max-T_ss)/(T_min-T_ss)]',
    params: { R, C, eta, P_rated: P, T_target, delta: p.delta },
    category,
  };
}

/**
 * 式(3): 正常运行停机时间
 *   t_off = R·C·ln[(T_out - T_min) / (T_out - T_max)]
 *
 * AC关闭时，室温从 T_min 上升到 T_max 所需时间
 *
 * @param {string} category  区域类型
 * @param {number} T_out     室外温度 (°C)
 * @returns {Object} 停机时间及参数
 */
function computeOffTime(category, T_out) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const R = p.R, C = p.C;
  const T_target = p.T_target;
  const T_max = T_target + p.delta / 2;
  const T_min = T_target - p.delta / 2;

  // 式(3): t_off = R·C·ln[(T_out - T_min) / (T_out - T_max)]
  // 温度从 T_min 上升到 T_max，T_out > T_max > T_min
  const numerator = T_out - T_min;
  const denominator = T_out - T_max;

  if (numerator <= 0 || denominator <= 0 || numerator <= denominator) {
    return {
      t_off: Infinity,
      t_off_min: Infinity,
      T_max, T_min,
      formula: 't_off = R·C·ln[(T_out-T_min)/(T_out-T_max)]',
      note: '室外温度低于设定温度，无需制冷',
      category,
    };
  }

  const t_off = R * C * Math.log(numerator / denominator);

  return {
    t_off: Math.round(t_off * 100) / 100,
    t_off_min: Math.round(t_off * 60 * 10) / 10,
    T_max, T_min,
    numerator: Math.round(numerator * 100) / 100,
    denominator: Math.round(denominator * 100) / 100,
    formula: 't_off = R·C·ln[(T_out-T_min)/(T_out-T_max)]',
    params: { R, C, T_target, delta: p.delta },
    category,
  };
}

/**
 * 正常运行占空比
 *   duty = t_on / (t_on + t_off)
 */
function computeDutyCycle(category, T_out) {
  const on = computeOnTime(category, T_out);
  const off = computeOffTime(category, T_out);

  if (on.t_on === Infinity || off.t_off === Infinity) {
    return {
      duty: 1.0,
      t_on: on.t_on,
      t_off: off.t_off,
      cycle: Infinity,
      avgPower: ETP_PARAMS[category]?.P_rated || 1200,
      formula: 'duty = t_on / (t_on + t_off)',
      note: '极端工况，空调持续运行',
      category,
    };
  }

  const cycle = on.t_on + off.t_off;
  const duty = on.t_on / cycle;
  const P = ETP_PARAMS[category]?.P_rated || 1200;

  return {
    duty: Math.round(duty * 1000) / 1000,
    duty_pct: Math.round(duty * 1000) / 10,
    t_on: on.t_on,
    t_off: off.t_off,
    cycle: Math.round(cycle * 100) / 100,
    cycle_min: Math.round(cycle * 60 * 10) / 10,
    avgPower: Math.round(P * duty * 100) / 100,
    formula: 'duty = t_on / (t_on + t_off)',
    category,
  };
}

// ===========================================================================
// ─── 式(4) 计及回流功率的恢复阶段开机时间 ──────────────────────────────────
// ===========================================================================

/**
 * 式(4): 计及回流功率的恢复阶段空调开机时间
 *
 * 故障期间空调失电停机，室温从 T_max 超调上升至 T_recovery (> T_max)
 * 恢复供电后，空调需要从 T_recovery 降温至 T_max，这段时间比正常运行开机时间长
 *
 * t_on_recovery = R·C·ln[(T_out - ηPR - T_max) / (T_out - ηPR - T_recovery)]
 *
 * 回流功率系数:
 *   δ_reflow = (T_recovery - T_max) / (T_max - T_min)
 *   P_reflow = P_rated · (1 + δ_reflow)  恢复阶段额外功率需求
 *
 * @param {string} category     区域类型
 * @param {number} T_out        室外温度 (°C)
 * @param {number} T_recovery   故障期间达到的最高室温 (°C)
 * @returns {Object} 恢复阶段开机时间及回流功率
 */
function computeRecoveryOnTime(category, T_out, T_recovery) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const R = p.R, C = p.C, eta = p.eta, P = p.P_rated;
  const T_target = p.T_target;
  const T_max = T_target + p.delta / 2;
  const T_min = T_target - p.delta / 2;

  // 故障持续时间估算（基于温度超调量反推）
  // T_recovery = T_out + (T_max - T_out)·e^(-t_fault/τ) → t_fault = -τ·ln((T_recovery-T_out)/(T_max-T_out))
  const tau = R * C;
  let t_fault = null;
  if (T_recovery > T_max && T_out > T_max) {
    const ratio = (T_recovery - T_out) / (T_max - T_out);
    if (ratio > 0 && ratio < 1) {
      t_fault = -tau * Math.log(ratio);
    }
  } else if (T_recovery > T_max) {
    t_fault = tau * Math.log((T_recovery - T_out) / (T_max - T_out));
    if (t_fault < 0) t_fault = null;
  }

  // 式(4): t_on_recovery = R·C·ln[(T_recovery - T_ss_on) / (T_max - T_ss_on)]
  // 温度从 T_recovery 下降到 T_max，T_ss_on < T_max < T_recovery
  const T_ss_on = T_out - R * eta * P;
  const T_rec_minus_ss = T_recovery - T_ss_on;  // > 0
  const T_max_minus_ss_rec = T_max - T_ss_on;    // > 0

  let t_on_rec = Infinity;
  if (T_rec_minus_ss > 0 && T_max_minus_ss_rec > 0 && T_rec_minus_ss > T_max_minus_ss_rec) {
    t_on_rec = R * C * Math.log(T_rec_minus_ss / T_max_minus_ss_rec);
  }

  // 正常开机时间（对比用）
  const normal_on = computeOnTime(category, T_out);

  // 回流功率系数
  const delta_T = T_recovery - T_max;
  const delta_normal = T_max - T_min;
  const reflowFactor = delta_normal > 0 ? delta_T / delta_normal : 0;
  const P_reflow = P * (1 + reflowFactor);

  // 超调比
  const overshootRatio = normal_on.t_on > 0 ? t_on_rec / normal_on.t_on : Infinity;

  return {
    t_on_recovery: Math.round(t_on_rec * 100) / 100,
    t_on_recovery_min: Math.round(t_on_rec * 60 * 10) / 10,
    t_on_normal: normal_on.t_on,
    t_on_normal_min: normal_on.t_on_min,
    overshoot_ratio: Math.round(overshootRatio * 100) / 100,
    T_recovery: Math.round(T_recovery * 100) / 100,
    T_max,
    T_min,
    T_ss_on: Math.round(T_ss_on * 100) / 100,
    t_fault_estimated: t_fault !== null ? Math.round(t_fault * 100) / 100 : null,
    t_fault_min: t_fault !== null ? Math.round(t_fault * 60 * 10) / 10 : null,
    reflowFactor: Math.round(reflowFactor * 1000) / 1000,
    P_rated: P,
    P_reflow: Math.round(P_reflow * 100) / 100,
    reflow_extra: Math.round((P_reflow - P) * 100) / 100,
    formula: 't_on_rec = R·C·ln[(T_rec-T_ss)/(T_max-T_ss)]',
    numerator: Math.round(T_rec_minus_ss * 100) / 100,
    denominator: Math.round(T_max_minus_ss_rec * 100) / 100,
    category,
  };
}

// ===========================================================================
// ─── 式(5) 空调聚合功率模型 ────────────────────────────────────────────────
// ===========================================================================

/**
 * 式(5): 空调聚合功率模型
 *
 * P_agg(t) = Σ_{i=1}^{N} s_i(t) · P_rated_i · [1 + δ_reflow_i(t)]
 *
 * 考虑空调群的开关状态分布和回流功率效应
 *
 * @param {Array} nodes  节点列表 [{category, T_out, T_in, s, T_recovery?}]
 * @param {number} dt    时间步长 (min)
 * @returns {Object} 聚合功率及各节点详情
 */
function computeAggregatedPower(nodes, dt_min = 15) {
  const details = nodes.map(node => {
    const p = ETP_PARAMS[node.category] || ETP_PARAMS.commercial;
    const T_max = p.T_target + p.delta / 2;
    const T_min = p.T_target - p.delta / 2;

    // 判断空调状态
    let s = node.s;
    if (s === undefined) {
      // 自动判断：温度高于T_max则开启，低于T_min则关闭
      s = node.T_in >= T_max ? 1 : (node.T_in <= T_min ? 0 : 1);
    }

    // 回流功率系数
    let reflowFactor = 0;
    if (node.T_recovery && node.T_recovery > T_max) {
      const delta_T = node.T_recovery - T_max;
      const delta_normal = T_max - T_min;
      reflowFactor = delta_normal > 0 ? delta_T / delta_normal : 0;
    }

    // 占空比（式2+式3 → duty = t_on / (t_on + t_off)）
    const dutyCycle = computeDutyCycle(node.category, node.T_out);

    // 单台功率
    const P_unit = p.P_rated * (1 + reflowFactor);

    // 聚合到该区域总功率 = 区域总额定功率 × 占空比 × (1+回流系数)
    const P_zone = p.zone_power * dutyCycle.duty * (1 + reflowFactor);

    // ETP 模型计算下一时刻温度
    const etp = etpModel(node.category, node.T_in, node.T_out, dt_min, s);

    return {
      category: node.category,
      T_in: etp.T_in,
      T_out: node.T_out,
      s,
      P_unit: Math.round(P_unit * 100) / 100,
      P_rated: p.P_rated,
      zone_power: p.zone_power,
      reflowFactor: Math.round(reflowFactor * 1000) / 1000,
      N_units: p.N_units,
      activeUnits: Math.round(p.N_units * dutyCycle.duty),
      P_zone: Math.round(P_zone * 100) / 100,
      dutyCycle: dutyCycle.duty,
      duty_pct: dutyCycle.duty_pct || Math.round(dutyCycle.duty * 1000) / 10,
      t_on: dutyCycle.t_on,
      t_off: dutyCycle.t_off,
      etp,
    };
  });

  const totalPower = details.reduce((s, d) => s + d.P_zone, 0);
  const totalUnits = details.reduce((s, d) => s + d.N_units, 0);
  const totalActive = details.reduce((s, d) => s + d.activeUnits, 0);
  const totalReflow = details.reduce((s, d) => s + d.reflowFactor * d.P_zone, 0);

  return {
    totalPower: Math.round(totalPower * 100) / 100,
    totalUnits,
    totalActive,
    activeRatio: Math.round(totalActive / totalUnits * 1000) / 1000,
    reflowPower: Math.round(totalReflow * 100) / 100,
    reflowRatio: totalPower > 0 ? Math.round(totalReflow / totalPower * 1000) / 1000 : 0,
    nodes: details,
    formula: 'P_agg(t) = Σ s_i(t)·P_rated_i·[1+δ_reflow_i(t)]',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 式(6) 蓄热式电采暖热动态模型 ──────────────────────────────────────────
// ===========================================================================

/**
 * 式(6): 蓄热式电采暖热动态模型
 *
 * C·dT_in/dt = (T_out - T_in)/R + P_heat + P_charge - P_discharge
 *
 * @param {Object} params
 * @returns {Object}
 */
function computeHeatStorageModel(params) {
  const {
    category = 'residential',
    T_in0 = 20,
    T_out = -5,
    P_heat = 0,       // 直接供暖功率 (kW)
    P_charge = 0,     // 蓄热功率 (kW)
    P_discharge = 0,  // 放热功率 (kW)
    dt_min = 15,
    SOC0 = 0.5,       // 初始蓄热量 (0-1)
    SOC_max = 1.0,
    SOC_min = 0.1,
    storage_capacity_kwh = 200,
  } = params;

  const p = ETP_PARAMS[category] || ETP_PARAMS.residential;
  const R = p.R, C = p.C;
  const dt_h = dt_min / 60;
  const tau = R * C;

  // 室温动态
  const heat_balance = (T_out - T_in0) / R + P_heat + P_charge - P_discharge;
  const T_in_new = T_in0 + (heat_balance / C) * dt_h;

  // 蓄热量动态
  const SOC_new = SOC0 + (P_charge - P_discharge) / storage_capacity_kwh * dt_h;
  const SOC_clamped = Math.max(SOC_min, Math.min(SOC_max, SOC_new));

  return {
    T_in: Math.round(T_in_new * 100) / 100,
    T_in_prev: T_in0,
    T_out,
    heat_balance: Math.round(heat_balance * 100) / 100,
    SOC: Math.round(SOC_clamped * 1000) / 1000,
    SOC_prev: SOC0,
    SOC_max,
    SOC_min,
    storage_kwh: storage_capacity_kwh,
    P_heat, P_charge, P_discharge,
    formula: 'C·dT/dt = (T_out-T_in)/R + P_heat + P_charge - P_discharge',
    category,
  };
}

// ===========================================================================
// ─── 式(7) PMV舒适温度模型 ─────────────────────────────────────────────────
// ===========================================================================

/**
 * 式(7): PMV舒适温度模型
 *
 * 基于Fanger热舒适方程，简化为温度边界计算
 * PMV = f(T_air, T_radiant, RH, v_air, clothing, activity)
 *
 * 简化模型: 在给定条件下计算舒适温度范围
 *
 * @param {Object} params
 * @returns {Object}
 */
function computePMVComfort(params) {
  const {
    RH = 55,
    v_air = 0.15,        // 风速 m/s
    clothing = 0.5,       // 服装热阻 (clo) 夏季0.5, 冬季1.0
    activity = 1.2,       // 代谢率 (met)
    T_target = 24,
    tolerance = 2.0,
  } = params;

  // 简化PMV计算（线性化近似）
  // PMV ≈ 0.1·(T_air - T_neutral) + 0.05·(RH - 50) - 0.2·v_air + 0.3·(clothing - 0.5)
  // T_neutral 取决于服装和活动量
  const T_neutral = 24 - 0.5 * (clothing - 0.5) - 0.2 * (activity - 1.2);

  // 在目标温度下的PMV值
  const PMV = 0.1 * (T_target - T_neutral) + 0.05 * (RH - 50) - 0.2 * v_air + 0.3 * (clothing - 0.5);

  // 舒适温度范围 (|PMV| < 0.5)
  const T_comfort_min = T_neutral - 5 - 0.05 * (RH - 50) + 0.2 * v_air;
  const T_comfort_max = T_neutral + 5 - 0.05 * (RH - 50) + 0.2 * v_air;

  // 有效舒适边界（考虑容忍度）
  const T_effective_min = Math.max(T_target - tolerance, T_comfort_min);
  const T_effective_max = Math.min(T_target + tolerance, T_comfort_max);

  // 舒适度评分 (0-1)
  const comfortScore = Math.max(0, 1 - Math.abs(PMV) / 3);

  return {
    PMV: Math.round(PMV * 1000) / 1000,
    T_neutral: Math.round(T_neutral * 100) / 100,
    T_comfort_min: Math.round(T_comfort_min * 100) / 100,
    T_comfort_max: Math.round(T_comfort_max * 100) / 100,
    T_effective_min: Math.round(T_effective_min * 100) / 100,
    T_effective_max: Math.round(T_effective_max * 100) / 100,
    comfortScore: Math.round(comfortScore * 1000) / 1000,
    comfortLevel: comfortScore > 0.8 ? 'comfortable' : comfortScore > 0.5 ? 'acceptable' : 'uncomfortable',
    formula: 'PMV = f(T_air, T_rad, RH, v_air, clo, met)',
    params: { RH, v_air, clothing, activity, T_target, tolerance },
  };
}

// ===========================================================================
// ─── 式(11) 空调温度状态特征量（动态权重）──────────────────────────────────
// ===========================================================================

/**
 * 式(11): 空调温度状态特征量 — 动态权重
 *
 * ω_i(t) = ω_base + κ_T · (T_in_i - T_min_i) / (T_max_i - T_min_i)
 *
 * 当室内温度接近上限时，恢复优先级提高（权重增大）
 *
 * @param {string} category   区域类型
 * @param {number} T_in       当前室内温度
 * @param {number} omega_base 基础权重
 * @param {number} kappa_T    温度敏感系数
 * @returns {Object}
 */
function computeACWeight(category, T_in, omega_base = 0.5, kappa_T = 0.5) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const T_max = p.T_target + p.delta / 2;
  const T_min = p.T_target - p.delta / 2;

  // 归一化温度状态量 (0~1, 越接近1说明温度越接近上限)
  const T_norm = Math.max(0, Math.min(1, (T_in - T_min) / (T_max - T_min)));

  // 式(11)
  const omega = omega_base + kappa_T * T_norm;

  // 故障恢复超调情况
  let recovery_boost = 0;
  if (T_in > T_max) {
    recovery_boost = kappa_T * (T_in - T_max) / (T_max - T_min) * 0.5;
  }

  return {
    omega: Math.round((omega + recovery_boost) * 1000) / 1000,
    omega_base,
    kappa_T,
    T_in,
    T_max, T_min,
    T_norm: Math.round(T_norm * 1000) / 1000,
    recovery_boost: Math.round(recovery_boost * 1000) / 1000,
    priority_level: T_norm > 0.8 ? 'critical' : T_norm > 0.6 ? 'high' : T_norm > 0.4 ? 'medium' : 'low',
    formula: 'ω = ω_base + κ_T·(T_in-T_min)/(T_max-T_min)',
    category,
  };
}

// ===========================================================================
// ─── 式(12) 蓄热状态特征量（动态权重）──────────────────────────────────────
// ===========================================================================

/**
 * 式(12): 蓄热状态特征量 — 动态权重
 *
 * ω_i(t) = ω_base + κ_S · (SOC_max - SOC_i) / (SOC_max - SOC_min)
 *
 * 当蓄热量较低时，供暖恢复优先级提高
 *
 * @param {number} SOC       当前蓄热量 (0-1)
 * @param {number} omega_base 基础权重
 * @param {number} kappa_S    蓄热敏感系数
 * @returns {Object}
 */
function computeStorageWeight(SOC, omega_base = 0.5, kappa_S = 0.5) {
  const SOC_max = 1.0;
  const SOC_min = 0.1;

  // 归一化蓄热亏缺量 (0~1, 越接近1说明蓄热越不足)
  const S_deficit = Math.max(0, Math.min(1, (SOC_max - SOC) / (SOC_max - SOC_min)));

  // 式(12)
  const omega = omega_base + kappa_S * S_deficit;

  return {
    omega: Math.round(omega * 1000) / 1000,
    omega_base,
    kappa_S,
    SOC,
    SOC_max, SOC_min,
    S_deficit: Math.round(S_deficit * 1000) / 1000,
    priority_level: S_deficit > 0.8 ? 'critical' : S_deficit > 0.6 ? 'high' : S_deficit > 0.4 ? 'medium' : 'low',
    formula: 'ω = ω_base + κ_S·(SOC_max-SOC)/(SOC_max-SOC_min)',
  };
}

// ===========================================================================
// ─── 式(9) 负荷恢复收益函数 ─────────────────────────────────────────────────
// ===========================================================================

/**
 * 式(9): 负荷恢复收益函数
 *
 * R_i(t) = ω_i(t) · P_i(t) · Δt
 *
 * @param {Array} nodes  节点列表 [{category, T_in, P_load, SOC?}]
 * @param {number} dt_h  时间步长 (小时)
 * @returns {Object}
 */
function computeRecoveryBenefit(nodes, dt_h = 0.5) {
  const details = nodes.map(node => {
    // 夏季空调: 使用式(11)动态权重
    const acWeight = computeACWeight(node.category, node.T_in);

    // 冬季蓄热: 使用式(12)动态权重
    let storageWeight = null;
    if (node.SOC !== undefined) {
      storageWeight = computeStorageWeight(node.SOC);
    }

    // 综合权重: 取空调和蓄热的较大值
    const omega = storageWeight ? Math.max(acWeight.omega, storageWeight.omega) : acWeight.omega;

    // 式(9)
    const R = omega * node.P_load * dt_h;

    return {
      category: node.category,
      T_in: node.T_in,
      P_load: node.P_load,
      omega_ac: acWeight.omega,
      omega_storage: storageWeight?.omega || null,
      omega: omega,
      R: Math.round(R * 1000) / 1000,
      priority: acWeight.priority_level,
    };
  });

  const totalR = details.reduce((s, d) => s + d.R, 0);

  return {
    total: Math.round(totalR * 1000) / 1000,
    nodes: details,
    dt_h,
    formula: 'R_i(t) = ω_i(t)·P_i(t)·Δt',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 式(10) 开关动作代价函数 ───────────────────────────────────────────────
// ===========================================================================

/**
 * 式(10): 开关动作代价函数
 *
 * C_j(t) = λ_j · |S_j(t) - S_j(t-1)|
 *
 * @param {Array} switches  开关状态变化 [{id, S_prev, S_now, lambda}]
 * @returns {Object}
 */
function computeSwitchCost(switches) {
  const details = switches.map(sw => {
    const action = Math.abs(sw.S_now - sw.S_prev);
    const cost = sw.lambda * action;
    return {
      id: sw.id,
      S_prev: sw.S_prev,
      S_now: sw.S_now,
      action: action,
      lambda: sw.lambda,
      cost: Math.round(cost * 1000) / 1000,
      type: sw.S_now > sw.S_prev ? 'close' : (sw.S_now < sw.S_prev ? 'open' : 'no_change'),
    };
  });

  const totalCost = details.reduce((s, d) => s + d.cost, 0);
  const totalActions = details.reduce((s, d) => s + d.action, 0);

  return {
    totalCost: Math.round(totalCost * 1000) / 1000,
    totalActions,
    switches: details,
    formula: 'C_j(t) = λ_j·|S_j(t) - S_j(t-1)|',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 式(8) 综合目标函数 ─────────────────────────────────────────────────────
// ===========================================================================

/**
 * 式(8): 综合目标函数
 *
 * max J = Σ_i ω_i(t)·R_i(t) - Σ_j λ_j·C_j(t)
 *
 * 以"恢复收益最大化、动作代价最小化"为优化主线
 *
 * @param {Object} params
 * @returns {Object}
 */
function computeObjectiveV3(params) {
  const {
    nodes = [
      { category: 'commercial',  T_in: 25.5, P_load: 1200 },
      { category: 'residential', T_in: 26.5, P_load: 850 },
      { category: 'industrial',  T_in: 23.0, P_load: 650 },
      { category: 'datacenter',  T_in: 22.5, P_load: 500 },
      { category: 'hospital',    T_in: 23.3, P_load: 400 },
    ],
    switches = [],
    dt_h = 0.5,
    scenario = 'normal',  // 'normal' | 'fault' | 'recovery'
  } = params;

  // 计算负荷恢复收益 (式9)
  const recovery = computeRecoveryBenefit(nodes, dt_h);

  // 计算开关动作代价 (式10)
  const switchCost = computeSwitchCost(switches.length > 0 ? switches : []);

  // 式(8)
  const J = recovery.total - switchCost.totalCost;

  // 场景自适应权重分析
  const scenarioWeights = {
    normal:   { recovery: 0.3, cost: 0.7, note: '正常运行：侧重经济性' },
    fault:    { recovery: 0.8, cost: 0.2, note: '故障场景：侧重恢复速度' },
    recovery: { recovery: 0.6, cost: 0.4, note: '恢复阶段：平衡恢复与代价' },
  };
  const sw = scenarioWeights[scenario] || scenarioWeights.normal;
  const J_weighted = sw.recovery * recovery.total - sw.cost * switchCost.totalCost;

  // 评级
  const rating = J_weighted > 500 ? 'excellent' : J_weighted > 200 ? 'good' : J_weighted > 50 ? 'acceptable' : 'poor';

  return {
    J: Math.round(J * 1000) / 1000,
    J_weighted: Math.round(J_weighted * 1000) / 1000,
    recovery_benefit: recovery.total,
    switch_cost: switchCost.totalCost,
    recovery_details: recovery.nodes,
    switch_details: switchCost.switches,
    scenario,
    scenario_weights: sw,
    rating,
    formula: 'max J = Σω_i(t)·R_i(t) - Σλ_j·C_j(t)',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 故障恢复优化（核心调度算法）────────────────────────────────────────────
// ===========================================================================

/**
 * 故障恢复优化 — 基于动态权重的恢复策略
 *
 * 1. 根据各节点温度状态计算动态权重 (式11/12)
 * 2. 按权重排序确定恢复顺序
 * 3. 计算恢复收益 (式9) 和开关代价 (式10)
 * 4. 综合目标函数评估 (式8)
 *
 * @param {Object} params
 * @returns {Object}
 */
function optimizeFaultRecovery(params) {
  const {
    nodes = [
      { category: 'commercial',  T_in: 28.5, P_load: 1200, T_out: 35, T_recovery: 28.5 },
      { category: 'residential', T_in: 29.0, P_load: 850,  T_out: 35, T_recovery: 29.0 },
      { category: 'industrial',  T_in: 26.0, P_load: 650,  T_out: 35, T_recovery: 26.0 },
      { category: 'datacenter',  T_in: 24.0, P_load: 500,  T_out: 35, T_recovery: 24.0 },
      { category: 'hospital',    T_in: 24.5, P_load: 400,  T_out: 35, T_recovery: 24.5 },
    ],
    T_out = 35,
    dt_h = 0.5,
    max_parallel = 3,  // 最大并行恢复节点数
  } = params;

  // Step 1: 计算各节点动态权重
  const weighted = nodes.map(node => {
    const p = ETP_PARAMS[node.category] || ETP_PARAMS.commercial;
    const T_max = p.T_target + p.delta / 2;
    const T_min = p.T_target - p.delta / 2;

    const acWeight = computeACWeight(node.category, node.T_in);
    const recovery = computeRecoveryOnTime(node.category, node.T_out, node.T_recovery);
    const pmv = computePMVComfort({ T_target: p.T_target, tolerance: p.comfort_tol });

    return {
      ...node,
      T_max, T_min,
      weight: acWeight.omega,
      weight_detail: acWeight,
      recovery_time: recovery.t_on_recovery,
      recovery_detail: recovery,
      pmv,
      priority: acWeight.priority_level,
      benefit: acWeight.omega * node.P_load * dt_h,
    };
  });

  // Step 2: 按权重排序（高权重优先恢复）
  const sorted = [...weighted].sort((a, b) => b.weight - a.weight);

  // Step 3: 分批恢复（考虑并行约束）
  const batches = [];
  let remaining = [...sorted];
  let batchIdx = 0;

  while (remaining.length > 0) {
    const batch = remaining.slice(0, max_parallel);
    remaining = remaining.slice(max_parallel);

    // 计算该批次的开关代价
    const switches = batch.map(node => ({
      id: node.category,
      S_prev: 0,
      S_now: 1,
      lambda: 0.5 + (5 - batchIdx) * 0.1,  // 越早恢复代价越低
    }));

    const switchCost = computeSwitchCost(switches);
    const batchBenefit = batch.reduce((s, n) => s + n.benefit, 0);
    const batchJ = batchBenefit - switchCost.totalCost;

    batches.push({
      batch: batchIdx + 1,
      nodes: batch.map(n => ({
        category: n.category,
        T_in: n.T_in,
        T_max: n.T_max,
        weight: n.weight,
        priority: n.priority,
        P_load: n.P_load,
        recovery_time: n.recovery_time,
        recovery_time_min: n.recovery_detail.t_on_recovery_min,
        reflowFactor: n.recovery_detail.reflowFactor,
        P_reflow: n.recovery_detail.P_reflow,
        benefit: Math.round(n.benefit * 1000) / 1000,
      })),
      switch_cost: switchCost.totalCost,
      recovery_benefit: Math.round(batchBenefit * 1000) / 1000,
      J: Math.round(batchJ * 1000) / 1000,
    });

    batchIdx++;
  }

  // Step 4: 综合目标函数 (式8)
  const allSwitches = batches.flatMap((b, i) =>
    b.nodes.map(n => ({
      id: n.category,
      S_prev: 0,
      S_now: 1,
      lambda: 0.5 + (5 - i) * 0.1,
    }))
  );

  const objective = computeObjectiveV3({
    nodes: nodes.map(n => ({ category: n.category, T_in: n.T_in, P_load: n.P_load })),
    switches: allSwitches,
    dt_h,
    scenario: 'recovery',
  });

  // 总恢复时间
  const totalRecoveryTime = batches.reduce((max, b) =>
    Math.max(max, ...b.nodes.map(n => n.recovery_time || 0)), 0);

  return {
    objective,
    batches,
    recovery_order: sorted.map(n => ({
      category: n.category,
      weight: n.weight,
      priority: n.priority,
      T_in: n.T_in,
      T_max: n.T_max,
      recovery_time_min: n.recovery_detail.t_on_recovery_min,
      reflow_power: n.recovery_detail.P_reflow,
    })),
    total_recovery_time: Math.round(totalRecoveryTime * 100) / 100,
    total_recovery_time_min: Math.round(totalRecoveryTime * 60 * 10) / 10,
    total_switch_cost: batches.reduce((s, b) => s + b.switch_cost, 0),
    total_recovery_benefit: batches.reduce((s, b) => s + b.recovery_benefit, 0),
    formula_ref: '式(4)(8)(9)(10)(11)',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── MPC 滚动时域优化（基于ETP模型）────────────────────────────────────────
// ===========================================================================

/**
 * MPC 滚动时域优化 — 基于 ETP 模型预测温控负荷
 *
 * 1. 使用式(1) ETP模型预测未来N步室内温度
 * 2. 使用式(2)(3)计算开停机时间，确定占空比
 * 3. 使用式(5)聚合功率，考虑式(4)回流功率
 * 4. 优化温度偏移以最小化能耗成本+越界惩罚
 *
 * @param {Object} params
 * @returns {Object}
 */
function mpcOptimizeV3(params) {
  const {
    zones = [
      { id: 'comm', category: 'commercial',  T_in: 22.9, priority: 2 },
      { id: 'resi', category: 'residential', T_in: 25.5, priority: 1 },
      { id: 'indu', category: 'industrial',  T_in: 21.8, priority: 3 },
      { id: 'data', category: 'datacenter',  T_in: 21.2, priority: 1 },
      { id: 'hosp', category: 'hospital',    T_in: 22.5, priority: 1 },
    ],
    T_env_forecast = [28, 27, 26, 26, 27, 29, 31, 33, 34, 35, 35, 34],
    price_forecast = [220, 200, 190, 180, 190, 220, 280, 350, 420, 480, 520, 560],
    gridCapacity = 3500,
    N_horizon = 6,
    dt_min = 30,
  } = params;

  const N = Math.min(N_horizon, T_env_forecast.length);
  const dt_h = dt_min / 60;

  // 为每个zone搜索最优温度偏移
  const candidates = [-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5];

  function evaluateZone(zone, offset, T_env_series) {
    const p = ETP_PARAMS[zone.category] || ETP_PARAMS.commercial;
    let T_in = zone.T_in;
    let totalEnergy = 0, totalCost = 0, maxDev = 0;
    const trajectory = [];

    for (let t = 0; t < T_env_series.length; t++) {
      const T_out = T_env_series[t];
      const T_target = p.T_target + offset;
      const T_max = T_target + p.delta / 2;
      const T_min = T_target - p.delta / 2;

      // 确定空调状态
      const s = T_in >= T_max ? 1 : (T_in <= T_min ? 0 : 1);

      // ETP模型计算
      const etp = etpModel(zone.category, T_in, T_out, dt_min, s);
      T_in = etp.T_in;

      // 占空比计算
      const duty = computeDutyCycle(zone.category, T_out);

      // 功率
      const P_zone = p.zone_power * duty.duty;  // 简化聚合
      const energy = P_zone * dt_h;
      const cost = energy * (price_forecast[t] || 350) / 1000;

      totalEnergy += energy;
      totalCost += cost;
      maxDev = Math.max(maxDev, Math.abs(T_in - T_target));

      trajectory.push({
        t,
        T_in: Math.round(T_in * 100) / 100,
        T_out,
        s,
        P: Math.round(P_zone * 100) / 100,
        duty: duty.duty,
      });
    }

    return {
      offset,
      totalEnergy: Math.round(totalEnergy * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      maxDeviation: Math.round(maxDev * 100) / 100,
      trajectory,
    };
  }

  // 对每个zone寻找最优偏移
  const recommendations = zones.map(zone => {
    let best = null;
    let bestScore = Infinity;

    for (const offset of candidates) {
      const result = evaluateZone(zone, offset, T_env_forecast.slice(0, N));
      // 评分 = 成本 + 舒适度惩罚 + 越界惩罚
      const comfortPenalty = result.maxDeviation > 2 ? result.maxDeviation * 100 : 0;
      const score = result.totalCost + comfortPenalty;

      if (score < bestScore) {
        bestScore = score;
        best = result;
      }
    }

    const p = ETP_PARAMS[zone.category] || ETP_PARAMS.commercial;
    const action = best.offset < -0.5 ? '预冷降温' : best.offset > 0.5 ? '放宽温控' : '维持当前';

    return {
      zoneId: zone.id,
      category: zone.category,
      currentTemp: zone.T_in,
      recommendedOffset: best.offset,
      newTarget: Math.round((p.T_target + best.offset) * 10) / 10,
      action,
      energy: best.totalEnergy,
      cost: best.totalCost,
      maxDeviation: best.maxDeviation,
      trajectory: best.trajectory,
      priority: zone.priority,
    };
  });

  // 汇总
  const totalEnergy = recommendations.reduce((s, r) => s + r.energy, 0);
  const totalCost = recommendations.reduce((s, r) => s + r.cost, 0);
  const peakLoad = Math.max(...recommendations.flatMap(r => r.trajectory.map(t => t.P)));

  return {
    horizon: N,
    controlIntervalMin: dt_min,
    forecast: {
      temperatures: T_env_forecast.slice(0, N),
      prices: price_forecast.slice(0, N),
    },
    recommendations,
    totalEnergy: Math.round(totalEnergy * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    peakLoad: Math.round(peakLoad * 100) / 100,
    gridCapacity,
    overflow: peakLoad > gridCapacity,
    formula_ref: '式(1)(2)(3)(5)',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 供需平衡优化（含聚合功率）──────────────────────────────────────────────
// ===========================================================================

/**
 * 供需平衡优化 — 发电成本最小化 + 聚合功率约束
 *
 * 使用式(5)聚合功率模型作为需求侧输入
 * 发电侧: min Σ C_gen_i(P_i) s.t. ΣP_i = P_load
 *
 * @param {Object} params
 * @returns {Object}
 */
function supplyDemandOptimizeV3(params) {
  const {
    generators = [
      { id: 'Gen1', name: '1号机组(煤电)', a: 0.0008, b: 0.32, c: 12, P_min: 200, P_max: 600, emission: 0.85, isRenewable: false },
      { id: 'Gen2', name: '2号机组(煤电)', a: 0.0009, b: 0.35, c: 10, P_min: 150, P_max: 500, emission: 0.90, isRenewable: false },
      { id: 'Gen3', name: '3号机组(气电)', a: 0.0012, b: 0.45, c: 8,  P_min: 100, P_max: 300, emission: 0.40, isRenewable: false },
      { id: 'Gen4', name: '光伏电站',     a: 0.0001, b: 0.08, c: 2,  P_min: 0,   P_max: 400, emission: 0,    isRenewable: true },
      { id: 'Gen5', name: '风力发电',     a: 0.0001, b: 0.06, c: 1,  P_min: 0,   P_max: 350, emission: 0,    isRenewable: true },
      { id: 'Gen6', name: '储能放电',     a: 0.0005, b: 0.25, c: 5,  P_min: 0,   P_max: 200, emission: 0.05, isRenewable: false },
    ],
    zones = [
      { category: 'commercial',  T_out: 35, T_in: 25.5 },
      { category: 'residential', T_out: 35, T_in: 26.5 },
      { category: 'industrial',  T_out: 35, T_in: 23.0 },
      { category: 'datacenter',  T_out: 35, T_in: 22.5 },
      { category: 'hospital',    T_out: 35, T_in: 23.3 },
    ],
    totalDemand = null,  // 如果为null则自动计算
    gridCapacity = 3500,
    carbonPrice = 60,
  } = params;

  // 使用式(5)计算聚合功率作为需求
  let aggPower = null;
  if (totalDemand === null && zones.length > 0) {
    const nodes = zones.map(z => ({ category: z.category, T_out: z.T_out, T_in: z.T_in }));
    aggPower = computeAggregatedPower(nodes);
  }
  const adjustedDemand = totalDemand || aggPower?.totalPower || 3022;

  // 等边际成本分配
  const sortedGens = [...generators].sort((a, b) => {
    if (a.isRenewable && !b.isRenewable) return -1;
    if (!a.isRenewable && b.isRenewable) return 1;
    return (2 * a.a * a.P_min + a.b) - (2 * b.a * b.P_min + b.b);
  });

  let remaining = adjustedDemand;
  const dispatch = [];

  for (const gen of sortedGens) {
    if (remaining <= 0) {
      dispatch.push({
        id: gen.id, name: gen.name, powerMW: 0, powerKW: 0, loadPercent: 0,
        generationCostYuan: 0, marginalCost: 0, emissionKgCO2: 0, carbonCostYuan: 0,
        isRenewable: gen.isRenewable,
      });
      continue;
    }
    const allocated = Math.min(gen.P_max, Math.max(gen.P_min, remaining));
    remaining -= allocated;

    const cost = gen.a * allocated * allocated + gen.b * allocated + gen.c;
    const emission = gen.emission * allocated;
    const carbonCost = (emission / 1000) * carbonPrice;

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

  const totalCost = dispatch.reduce((s, d) => s + d.generationCostYuan, 0);
  const totalEmission = dispatch.reduce((s, d) => s + d.emissionKgCO2, 0);
  const totalRenewable = dispatch.filter(d => d.isRenewable).reduce((s, d) => s + d.powerKW, 0);
  const renewablePercent = Math.round(totalRenewable / adjustedDemand * 100);

  return {
    totalDemandKW: Math.round(adjustedDemand),
    totalGenerationKW: Math.round(dispatch.reduce((s, d) => s + d.powerKW, 0)),
    aggregatedPower: aggPower,
    dispatch,
    summary: {
      totalCostYuan: Math.round(totalCost * 10) / 10,
      totalEmissionKgCO2: Math.round(totalEmission * 10) / 10,
      totalCarbonCostYuan: Math.round((totalEmission / 1000) * carbonPrice * 10) / 10,
      renewableKW: Math.round(totalRenewable),
      renewablePercent,
      capacityUtilization: Math.round(adjustedDemand / gridCapacity * 100),
    },
    isBalanced: Math.abs(dispatch.reduce((s, d) => s + d.powerKW, 0) - adjustedDemand) < 1,
    formula_ref: '式(5)',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 博弈论多目标优化（纳什议价解）──────────────────────────────────────────
// ===========================================================================

/**
 * 纳什议价解 — 基于ETP模型的效用函数
 *
 * max Π (U_i - d_i) s.t. U_i ≥ d_i
 *
 * 效用函数使用式(11)动态权重反映温度偏好
 *
 * @param {Object} params
 * @returns {Object}
 */
function nashBargainingOptimizeV3(params) {
  const {
    zones = [
      { id: 'commercial',  category: 'commercial',  T_target: 24, T_current: 25.5, powerKW: 1200, P_max: 1800, tolerance: 2.0, T_out: 30 },
      { id: 'residential', category: 'residential', T_target: 26, T_current: 26.5, powerKW: 850,  P_max: 1200, tolerance: 0.5, T_out: 30 },
      { id: 'industrial',  category: 'industrial',  T_target: 22, T_current: 23.0, powerKW: 650,  P_max: 900,  tolerance: 3.0, T_out: 30 },
      { id: 'datacenter',  category: 'datacenter',  T_target: 22, T_current: 22.5, powerKW: 500,  P_max: 700,  tolerance: 0.5, T_out: 30 },
      { id: 'hospital',    category: 'hospital',    T_target: 23, T_current: 23.3, powerKW: 400,  P_max: 550,  tolerance: 0.3, T_out: 30 },
    ],
    T_env = 30,
    totalPowerBudget = 4000,
  } = params;

  // 舒适度效用
  function comfortUtility(zone, T) {
    const delta = Math.abs(T - zone.T_target);
    if (delta <= zone.tolerance) return 1.0;
    return Math.max(0, 1 - Math.pow((delta - zone.tolerance) / zone.tolerance, 2));
  }

  // 功率效用
  function powerUtility(zone, P) {
    return Math.max(0, 1 - P / zone.P_max);
  }

  // 综合效用（使用式(11)动态权重）
  function totalUtility(zone, T, P) {
    const acWeight = computeACWeight(zone.category, T);
    // 温度越接近上限，舒适度权重越高
    const w_comfort = 0.3 + acWeight.T_norm * 0.4;
    const w_power = 1 - w_comfort;
    return w_comfort * comfortUtility(zone, T) + w_power * powerUtility(zone, P);
  }

  // 协调搜索
  const draftT = zones.map(z => z.T_current);
  const draftP = zones.map((z, i) => {
    const etp = etpModel(z.category, draftT[i], T_env, 30, 1);
    const p = ETP_PARAMS[z.category] || ETP_PARAMS.commercial;
    return p.zone_power;
  });

  // 迭代调整
  let totalP = draftP.reduce((s, p) => s + p, 0);
  const iterations = [];

  for (let iter = 0; iter < 5 && totalP > totalPowerBudget; iter++) {
    const order = zones.map((z, i) => ({
      idx: i,
      cw: totalUtility(z, draftT[i], draftP[i]),
    })).sort((a, b) => a.cw - b.cw);

    for (const { idx } of order) {
      if (totalP <= totalPowerBudget) break;
      const z = zones[idx];
      draftT[idx] += 0.3;
      const p = ETP_PARAMS[z.category] || ETP_PARAMS.commercial;
      const newP = computeDutyCycle(z.category, T_env).avgPower / (ETP_PARAMS[z.category]?.P_rated || 4) * (ETP_PARAMS[z.category]?.zone_power || 850);
      totalP -= draftP[idx] - newP;
      draftP[idx] = newP;
    }

    iterations.push({
      round: iter + 1,
      totalPower: Math.round(totalP),
      temperatures: draftT.map(t => Math.round(t * 10) / 10),
    });
  }

  // 最终分配
  const allocations = zones.map((z, i) => {
    const u_comfort = comfortUtility(z, draftT[i]);
    const u_power = powerUtility(z, draftP[i]);
    const u_total = totalUtility(z, draftT[i], draftP[i]);
    const acWeight = computeACWeight(z.category, draftT[i]);
    const disagreement = 0.3 + acWeight.T_norm * 0.2;

    return {
      id: z.id,
      category: z.category,
      T_target: z.T_target,
      T_allocated: Math.round(draftT[i] * 10) / 10,
      T_deviation: Math.round((draftT[i] - z.T_target) * 100) / 100,
      powerKW: Math.round(draftP[i]),
      dynamic_weight: acWeight.omega,
      weight_norm: acWeight.T_norm,
      utilities: {
        comfort: Math.round(u_comfort * 1000) / 1000,
        power: Math.round(u_power * 1000) / 1000,
        total: Math.round(u_total * 1000) / 1000,
      },
      gainOverDisagreement: Math.round(Math.max(0, u_total - disagreement) * 1000) / 1000,
    };
  });

  const totalAllocated = allocations.reduce((s, a) => s + a.powerKW, 0);
  const nashProd = allocations.reduce((prod, a) => prod * Math.max(0.001, a.gainOverDisagreement), 1);

  // Gini系数
  const gains = allocations.map(a => a.gainOverDisagreement);
  const meanGain = gains.reduce((s, g) => s + g, 0) / gains.length;
  let giniNum = 0;
  for (let i = 0; i < gains.length; i++)
    for (let j = 0; j < gains.length; j++)
      giniNum += Math.abs(gains[i] - gains[j]);
  const gini = Math.round(giniNum / (2 * gains.length * gains.length * Math.max(0.001, meanGain)) * 1000) / 1000;

  return {
    allocations,
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
    formula_ref: '式(1)(11)',
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// ─── 原有策略函数（保持向后兼容）────────────────────────────────────────────
// ===========================================================================

function computePrecoolingStrategy(params) {
  const {
    category = 'commercial', T_target = 24, thermal_mass = 180,
    T_env_forecast = [], precool_window_start = 4, precool_window_end = 7, precool_depth = 3.5,
  } = params;

  const T_precool = T_target - precool_depth;
  const coef = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const precool_hours = precool_window_end - precool_window_start;
  const extraPower = Math.round(thermal_mass * precool_depth / precool_hours);
  const peakHours = [13, 14, 15, 16, 17];
  let savingsPerHour = 0;
  peakHours.forEach(h => {
    if (T_env_forecast[h]) {
      const effective_t_reduction = precool_depth * Math.exp(-(h - precool_window_end) * 0.15);
      savingsPerHour += (coef.eta || 5.5) * Math.min(precool_depth, effective_t_reduction) * 10;
    }
  });
  const totalSavings = Math.round(savingsPerHour);
  const energyCost = Math.round(extraPower * precool_hours * 0.8);

  return {
    enabled: true, precool_temp: T_precool,
    precool_window: `${precool_window_start}:00-${precool_window_end}:00`,
    precool_depth, extra_power_kw: extraPower, estimated_savings_kw: totalSavings,
    net_benefit_kw: totalSavings - energyCost,
    savings_pct: Math.round(totalSavings / coef.P_rated * 100),
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
    const p = ETP_PARAMS[zone.category] || ETP_PARAMS.commercial;
    const duty = computeDutyCycle(zone.category, T_env);
    const baselineP = p.zone_power * duty.duty;
    const relaxedP = p.zone_power * computeDutyCycle(zone.category, T_env).duty * 0.85;
    const saved = Math.round((baselineP - relaxedP) * 100) / 100;
    return { ...zone, baseline_power: Math.round(baselineP), relaxed_power: Math.round(relaxedP), saved_kw: saved, saved_pct: Math.round(saved / baselineP * 100), duty_cycle: duty.duty, T_target: p.T_target, comfort_impact: zone.priority === 1 ? 'minimal' : zone.priority === 2 ? 'moderate' : 'acceptable' };
  });
  const totalBaseline = Math.round(results.reduce((s, r) => s + r.baseline_power, 0));
  const totalRelaxed = Math.round(results.reduce((s, r) => s + r.relaxed_power, 0));
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

function scoreRecoveryPlans(plans, currentState, weights = null) {
  const defaultWeights = { emergency: { w1: 0.15, w2: 0.25, w3: 0.60 }, normal: { w1: 0.55, w2: 0.30, w3: 0.15 } };
  const activeWeights = (currentState && currentState.fault_active) ? defaultWeights.emergency : defaultWeights.normal;
  const w = Object.assign({}, activeWeights, weights || {});
  const scored = plans.map(plan => {
    const energy = plan.extra_power_kw * plan.duration_min / 60;
    const loadGap = plan.affected_load_kw * plan.duration_min / 60;
    const recoveryCost = plan.duration_min * plan.affected_load_kw;
    const obj = { J: Math.round((w.w1 * energy / 100 + w.w2 * loadGap / 100 + w.w3 * recoveryCost / 10000) * 10000) / 10000 };
    return { ...plan, J: obj.J, weights_used: { ...w }, metrics: { energy, loadGap, recoveryCost } };
  });
  scored.sort((a, b) => a.J - b.J);
  if (scored.length > 0) scored[0].recommended = true;
  return { plans: scored, recommended: scored.length > 0 ? scored[0] : null, mode: currentState && currentState.fault_active ? 'emergency' : 'normal', timestamp: new Date().toISOString() };
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
// ─── 兼容接口（向后兼容 v2.0）──────────────────────────────────────────────
// ===========================================================================

function computeCoolingPowerV2(category, T_env, RH, T_prev, offset = 0) {
  const p = ETP_PARAMS[category] || ETP_PARAMS.commercial;
  const duty = computeDutyCycle(category, T_env);
  const power = p.P_rated * duty.duty;
  const copEffective = p.eta;
  return {
    power: Math.round(power * 100) / 100,
    deviation: Math.round(Math.max(0, T_env - p.T_target) * 100) / 100,
    basePower: p.P_rated,
    cop: copEffective,
    copNominal: p.eta,
    T_target: p.T_target,
    thermalMass: p.C,
    category,
    duty: duty.duty,
  };
}

function computeCoolingPower(category, T_env, offset = 0) {
  return computeCoolingPowerV2(category, T_env, 50, T_env, offset);
}

function computeObjectiveV2(metrics, weights = null) {
  const w = Object.assign({ w1: 0.35, w2: 0.25, w3: 0.25, w4: 0.15 }, weights || {});
  const E_base = 3500, D_base = 15, R_base = 500;
  const E_norm = metrics.energy / E_base;
  const D_norm = metrics.tempDeviation / D_base;
  const R_norm = metrics.recoveryCost / R_base;
  const carbonEmission = metrics.energy * CARBON_FACTOR;
  const C_norm = carbonEmission / 1500;
  const J = w.w1 * E_norm + w.w2 * D_norm + w.w3 * R_norm + w.w4 * C_norm;
  return {
    J: Math.round(J * 10000) / 10000,
    E_norm: Math.round(E_norm * 10000) / 10000,
    D_norm: Math.round(D_norm * 10000) / 10000,
    R_norm: Math.round(R_norm * 10000) / 10000,
    C_norm: Math.round(C_norm * 10000) / 10000,
    carbonEmission: Math.round(carbonEmission * 10) / 10,
    weights: { ...w },
    rating: J < 0.35 ? 'excellent' : J < 0.65 ? 'good' : J < 0.95 ? 'acceptable' : 'poor',
  };
}

function computeObjective(metrics, weights = null) {
  return computeObjectiveV2(metrics, weights);
}

function mpcOptimize(params) { return mpcOptimizeV3(params); }
function mpcSimulate24h(params) { return { steps: [], timeline: [], summary: {}, timestamp: new Date().toISOString() }; }
function supplyDemandOptimize(params) { return supplyDemandOptimizeV3(params); }
function nashBargainingOptimize(params) { return nashBargainingOptimizeV3(params); }

// ===========================================================================
// ─── 导出 ─────────────────────────────────────────────────────────────────
// ===========================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // 基础参数
    ETP_PARAMS, CARBON_FACTOR,
    // 式(1) ETP模型
    etpModel,
    // 式(2)(3) 开停机时间
    computeOnTime, computeOffTime, computeDutyCycle,
    // 式(4) 回流功率恢复时间
    computeRecoveryOnTime,
    // 式(5) 聚合功率
    computeAggregatedPower,
    // 式(6) 蓄热模型
    computeHeatStorageModel,
    // 式(7) PMV舒适模型
    computePMVComfort,
    // 式(11) 空调动态权重
    computeACWeight,
    // 式(12) 蓄热动态权重
    computeStorageWeight,
    // 式(9) 恢复收益
    computeRecoveryBenefit,
    // 式(10) 开关代价
    computeSwitchCost,
    // 式(8) 综合目标函数
    computeObjectiveV3,
    // 故障恢复优化
    optimizeFaultRecovery,
    // MPC
    mpcOptimizeV3, mpcOptimize,
    // 供需平衡
    supplyDemandOptimizeV3, supplyDemandOptimize,
    // 博弈论
    nashBargainingOptimizeV3, nashBargainingOptimize,
    // 兼容接口
    computeCoolingPowerV2, computeCoolingPower,
    computeObjectiveV2, computeObjective,
    computeCoolingMatrixV2: (zones, T_series) => ({ zones: [], totalSeries: [], nPoints: 0 }),
    computeCoolingMatrix: (zones, T_series) => ({ zones: [], totalSeries: [], nPoints: 0 }),
    // 原有策略
    computePrecoolingStrategy, computeZoneControlStrategy,
    computeNightStorageStrategy, computePeakShiftStrategy,
    computeDemandResponseCapability,
    scoreRecoveryPlans, recommendStrategies, simulateOptimization,
  };
}
