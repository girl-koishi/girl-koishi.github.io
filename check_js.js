const fs = require('fs');
const html = fs.readFileSync('dispatch-optimization.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('❌ 没有 script 标签'); process.exit(); }
const js = m[1];
console.log('JS 长度:', js.length, '字符');
const checks = [
  'fetch',
  'renderObjectiveV2',
  'renderAutoWeights',
  'renderStrategyCards',
  'refreshForecast',
  'pollState',
  'function init',
  'loadOptimizationState',
];
checks.forEach(c => {
  console.log(c + ':', js.includes(c) ? '✅' : '❌');
});
try { new Function(js); console.log('✅ JS 语法通过'); } catch (e) { console.log('❌ JS 语法错误:', e.message); }
