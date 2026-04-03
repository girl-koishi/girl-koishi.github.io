export const baseData = {
  // 万达商场数据
  wanda: {
    baseTemp: 24, // 基准温度
    currentTemp: 25, // 当前温度
    basePower: 16000, // 基准功率（W）
    currentPower: 15800, // 当前功率
    loadRate: 85, // 负载率
  },
  // 幸福小区数据
  community: {
    baseTemp: 25,
    currentTemp: 26,
    basePower: 10000,
    currentPower: 9800,
    loadRate: 72,
  },
  // 电网全局数据
  grid: {
    totalLoad: 75, // 电网负载率
    faultGap: 20, // 故障电力缺口
    plan1Energy: 14280, // 方案一总能耗
    plan2Energy: 12420, // 方案二总能耗
  }
}

// 曲线数据生成函数
export const generateLineData = (baseValue, waveRange, length = 24) => {
  return Array.from({ length }, () => {
    // 生成基准值上下波动的动态数据，替代固定的曲线数组
    return +(baseValue + (Math.random() - 0.5) * waveRange).toFixed(2)
  })
}
