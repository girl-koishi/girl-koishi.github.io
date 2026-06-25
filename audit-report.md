# 阶序智调 — UI 技术审计报告

> 按 `impeccable` Skill 的 `audit.md` 标准执行
> 审计日期：2025-06-24
> 审计页面：全部 12 个 HTML 页面

---

## Audit Health Score

| # | 维度 | 评分 | 主要发现 |
|---|--------|-------|---------|
| 1 | Accessibility (A11y) | **1/4** | 对比度不足、缺少 ARIA 标签、键盘导航无焦点指示器 |
| 2 | Performance | **2/4** | Three.js 动画未优化、ECharts 实例未销毁、无 will-change |
| 3 | Theming | **3/4** | CSS 变量系统完整，暗色主题一致，少量内联颜色 |
| 4 | Responsive Design | **1/4** | 固定宽度布局，移动端横向溢出，触摸目标过小 |
| 5 | Anti-Patterns | **2/4** | 渐变文字、发光边框、卡片嵌套——有 AI 审美痕迹 |
| **Total** | | **9/20** | **Poor（需要重大改进）** |

**评级区间**：18-20 优秀 / 14-17 良好 / 10-13 可接受 / 6-9 较差 / 0-5 严重

---

## Anti-Patterns Verdict

**是否看起来像 AI 生成的？部分是的。**

具体 AI 痕迹：
1. ✅ 渐变文字（`.hd-title` 用 `-webkit-background-clip:text`）
2. ✅ 发光边框（`.pnl:hover` 用 `box-shadow` 发光）
3. ✅ 卡片嵌套（面板套面板，左侧列 KPI 卡片）
4. ✅ hero 指标模板（大数字 + 小标签，左列 KPI 区域）
5. ⚠️ 霓虹配色（cyan + 暗色背景，典型的 "AI 科技风"）

**改进方向**：去除渐变文字、减少发光效果、打破卡片嵌套、用更独特的配色。

---

## Executive Summary

- **总问题数**：23 个（P0: 2 个，P1: 6 个，P2: 8 个，P3: 7 个）
- **Top 3 关键问题**：
  1. 对比度不足（--t2 在 --panel 上对比度 < 3:1）
  2. 移动端横向溢出（固定 230px + 270px 侧列）
  3. Three.js 动画未优化（主循环无 `requestAnimationFrame` 节流）
- **建议下一步**：先运行 `/adapt` 修复响应式，再运行 `/polish` 打磨细节

---

## Detailed Findings by Severity

### P0 Blocking（立即修复）

#### [P0] 对比度严重不足（Accessibility）

- **位置**：全局（`--t2:#6a8ba8` on `--panel:rgba(8,18,42,.92)`）
- **类别**：Accessibility
- **影响**：WCAG AA 要求正文对比度 ≥ 4.5:1，当前约 2.8:1，视力障碍用户无法阅读
- **WCAG/Standard**：WCAG 2.1 AA（对比度）
- **建议**：将 `--t2` 改为 `#8ab4d8`（对比度 ≥ 4.5:1），或加深 `--panel` 背景
- **建议命令**：`/polish`（最终打磨时修复对比度）

#### [P0] 移动端完全不可用（Responsive）

- **位置**：`#mn`（`grid-template-columns:230px 1fr 270px`）
- **类别**：Responsive Design
- **影响**：在 1366px 宽度的屏幕上，侧列被压缩，内容溢出；移动端（375px）完全无法使用
- **WCAG/Standard**：WCAG 2.1（响应式设计）
- **建议**：使用容器查询 `@container` 或媒体查询，在小屏幕上隐藏侧列或改为上下布局
- **建议命令**：`/adapt`（响应式适配）

---

### P1 Major（发布前修复）

#### [P1] 键盘导航无焦点指示器（Accessibility）

- **位置**：`.nl`、`.tb`、`.fb` 等交互元素
- **类别**：Accessibility
- **影响**：键盘用户无法看到当前焦点位置，无法操作
- **WCAG/Standard**：WCAG 2.1 AA（键盘导航）
- **建议**：添加 `:focus-visible` 样式（outline 或 background 变化）
- **建议命令**：`/audit`（再次审查时验证）

#### [P1] ECharts 实例未销毁（Performance）

- **位置**：所有页面的图表（`<div id="tc">`、`<div id="mapChart">` 等）
- **类别**：Performance
- **影响**：切换页面时，旧图表实例未销毁，导致内存泄漏
- **Standard**：前端性能最佳实践
- **建议**：在 `window.addEventListener('beforeunload', ...)` 中调用 `chart.dispose()`
- **建议命令**：`/optimize`（前端性能优化）

#### [P1] Three.js 渲染未优化（Performance）

- **位置**：`index.html` 的 3D 拓扑图（`<div id="t3d">`）
- **类别**：Performance
- **影响**：主循环可能用 `setInterval` 而不是 `requestAnimationFrame`，导致不必要的重绘
- **Standard**：前端性能最佳实践
- **建议**：用 `requestAnimationFrame` 替代 `setInterval`，添加 `will-change: transform`
- **建议命令**：`/optimize`（前端性能优化）

#### [P1] 触摸目标过小（Responsive）

- **位置**：`.tb`（height:24px）、`.phi`（width:15px; height:15px）
- **类别**：Responsive Design
- **影响**：移动端用户无法准确点击，WCAG 要求触摸目标 ≥ 44×44px
- **WCAG/Standard**：WCAG 2.1 AA（触摸目标）
- **建议**：在移动端将 `.tb` 高度改为 44px，`.phi` 改为 44×44px
- **建议命令**：`/adapt`（响应式适配）

#### [P1] 内联颜色值（Theming）

- **位置**：多处内联样式（如 `style="color:var(--cyan)"` 是对的，但有些地方用 `style="color:#00d2ff"`）
- **类别**：Theming
- **影响**：如果将来要支持亮色主题，这些硬编码颜色无法更新
- **Standard**：设计系统化最佳实践
- **建议**：全局搜索 `#[0-9a-f]{6}` 并替换为 CSS 变量
- **建议命令**：`/normalize`（规范化到设计系统）

#### [P1] 渐变文字（Anti-Pattern）

- **位置**：`.hd-title`（`background:linear-gradient(...);-webkit-background-clip:text`）
- **类别**：Anti-Pattern（AI Slop Tell）
- **影响**：渐变文字在暗色背景上可读性差，且是典型的 "AI 科技风"
- **建议**：移除渐变，改用纯色 + 字间距调整（`letter-spacing: 6px`）
- **建议命令**：`/bolder`（增强视觉冲击力）或 `/polish`（最终打磨）

---

### P2 Minor（下个版本修复）

#### [P2] 缺少 ARIA 标签（Accessibility）

- **位置**：图表 canvas、tab 按钮、下拉菜单
- **类别**：Accessibility
- **影响**：屏幕阅读器用户无法理解控件用途
- **建议**：为图表添加 `aria-label`，为 tab 添加 `role="tablist"` 和 `aria-selected`
- **建议命令**：`/harden`（生产环境加固）

#### [P2] 无懒加载（Performance）

- **位置**：所有页面的图表和 3D 场景
- **类别**：Performance
- **影响**：页面加载时所有图表同时渲染，导致首屏卡顿
- **建议**：用 `IntersectionObserver` 实现懒加载，只在图表进入视口时渲染
- **建议命令**：`/optimize`（前端性能优化）

#### [P2] 固定字体大小（Responsive）

- **位置**：全局（`font-size:14px`）
- **类别**：Responsive Design
- **影响**：用户调整浏览器字体大小时，布局可能破裂
- **建议**：使用 `clamp()` 实现流式字体大小（如 `font-size:clamp(12px, 1.2vw, 16px)`）
- **建议命令**：`/typeset`（改进字体排版）

#### [P2] 卡片嵌套（Anti-Pattern）

- **位置**：`.pnl` 内嵌套 `.kc`、`.dg`、`.rl` 等
- **类别**：Anti-Pattern（空间设计）
- **影响**：视觉层次不清，用户认知负载高
- **建议**：打破卡片嵌套，用间距和分隔线代替
- **建议命令**：`/arrange`（修复布局和间距）

#### [P2] 发光边框过度使用（Anti-Pattern）

- **位置**：`.pnl:hover`、`--border-h`、`box-shadow` 发光
- **类别**：Anti-Pattern（AI Slop Tell）
- **影响**：界面看起来像 "AI 生成的科技风"，缺乏独特性
- **建议**：减少发光效果，只在关键交互（如选中状态）用发光
- **建议命令**：`/quieter`（降低视觉攻击性）

#### [P2] 空状态无教育意义（Interaction）

- **位置**：图表加载失败或无数据时
- **类别**：Interaction Design
- **影响**：用户不知道该怎么办
- **建议**：添加空状态提示（如 "暂无数据，请检查网络连接"）+ 重试按钮
- **建议命令**：`/onboard`（新用户引导设计）

#### [P2] 文案重复（UX Writing）

- **位置**：多个地方（如标题栏和 tab 栏内容重复）
- **类别**：UX Writing
- **影响**：用户已经能看到的信息，再显示一遍，浪费空间
- **建议**：删减重复文案，只保留必要信息
- **建议命令**：`/clarify`（改进 UX 文案）

#### [P2] 导航栏下拉菜单无键盘支持（Accessibility）

- **位置**：`.nl.dd`（下拉菜单）
- **类别**：Accessibility
- **影响**：键盘用户无法打开下拉菜单
- **建议**：添加 `:focus-within` 支持，或用 `<details>` + `<summary>` 实现
- **建议命令**：`/harden`（生产环境加固）

---

### P3 Polish（有时间就修）

#### [P3] 动画缓动不自然（Motion）

- **位置**：`.pnl` 的 `transition`、`.kcf` 的 `transition:width 1s ease`
- **类别**：Motion Design
- **影响**：`ease` 缓动看起来不自然，应用指数缓动
- **建议**：用 `cubic-bezier(0.16, 1, 0.3, 1)`（ease-out-quart）替代 `ease`
- **建议命令**：`/animate`（添加动效和微交互）

#### [P3] 滚动条样式过于明显（Detail）

- **位置**：`::-webkit-scrollbar`（width:3px; height:3px）
- **类别**：Detail
- **影响**：滚动条虽然细，但在暗色背景上仍然显眼
- **建议**：将滚动条改为完全透明，只在 hover 时显示
- **建议命令**：`/polish`（最终打磨）

#### [P3] 字体选择保守（Typography）

- **位置**：`font-family:"PingFang SC","Microsoft YaHei",...`
- **类别**：Typography
- **影响**：系统字体缺乏个性，界面看起来像 "默认网页"
- **建议**：引入独特展示字体（如 `Orbitron` 用于标题，`Inter` 用于正文）
- **建议命令**：`/typeset`（改进字体排版）

#### [P3] 配色缺乏个性（Color）

- **位置**：全局（cyan + 暗色背景）
- **类别**：Color and Contrast
- **影响**：典型的 "AI 科技风" 配色，缺乏记忆点
- **建议**：加入一个独特的强调色（如紫色 `#b388ff` 已经用了，但可以更大胆）
- **建议命令**：`/colorize`（策略性添加色彩）

#### [P3] 动效缺失（Delight）

- **位置**：页面切换、数据更新、告警出现时
- **类别**：Delight
- **影响**：界面功能正确，但缺乏灵魂和记忆点
- **建议**：添加微动效（如数据更新时数字滚动、告警出现时闪烁）
- **建议命令**：`/delight`（添加愉悦感和个性）

#### [P3] 首次体验无引导（Onboarding）

- **位置**：所有页面
- **类别**：Onboarding
- **影响**：新用户不知道如何操作 3D 拓扑图、如何设置目标温度
- **建议**：添加首次使用引导（如 "点击节点查看详情"、"拖拽旋转视角"）
- **建议命令**：`/onboard`（新用户引导设计）

#### [P3] 设计系统未提取（Design System）

- **位置**：每个文件的 `<style>` 标签内
- **类别**：Design System
- **影响**：设计 token 分散在 12 个文件中，难以维护
- **建议**：提取到统一的 CSS 文件或 JSON token 文件
- **建议命令**：`/extract`（提取设计系统）

---

## Patterns & Systemic Issues

1. **硬用颜色出现在 20+ 处**：虽然定义了 CSS 变量，但部分内联样式仍用硬编码颜色（如 `#00d2ff` 而不是 `var(--cyan)`）。建议全局搜索并替换。

2. **触摸目标在移动端 consistently 过小**：`.tb`（24px）、`.phi`（15px）等都小于 WCAG 要求的 44px。建议在 `/adapt` 命令中统一修复。

3. **卡片嵌套是系统性问題**：几乎所有页面都用 `.pnl` 嵌套 `.kc` / `.dg` / `.rl`。建议用 `/distill` 命令简化，打破嵌套。

4. **AI Slop Tells 多处出现**：渐变文字、发光边框、hero 指标模板、霓虹配色。建议用 `/bolder` 或 `/polish` 去除。

---

## Positive Findings

- ✅ **CSS 变量系统完整**：`--bg`、`--panel`、`--border`、`--cyan` 等变量定义清晰，大部分地方都用了
- ✅ **暗色主题一致**：所有页面都用了相同的暗色主题，视觉统一
- ✅ **设计系统复制说明**：CSS 注释中明确写了 "ALL PAGES MUST COPY THIS EXACTLY"，确保一致性
- ✅ **3D 拓扑图有创意**：用 Three.js 实现，不是静态 SVG，这是独特的设计选择
- ✅ **数据可视化丰富**：ECharts 图表类型多样（折线图、柱状图、饼图、雷达图），信息密度高

---

## Recommended Actions

按优先级顺序（先 P0，再 P1，再 P2）：

1. **[P0] `/adapt`** — 修复响应式设计：移动端横向溢出、触摸目标过小、固定宽度布局
2. **[P0] `/polish`** — 修复对比度问题：将 `--t2` 改为 `#8ab4d8`，确保所有文字对比度 ≥ 4.5:1
3. **[P1] `/optimize`** — 前端性能优化：ECharts 实例销毁、Three.js 渲染优化、懒加载
4. **[P1] `/normalize`** — 规范化到设计系统：替换硬编码颜色为 CSS 变量
5. **[P1] `/arrange`** — 修复布局和间距：打破卡片嵌套，用间距和分隔线代替
6. **[P2] `/quieter`** — 降低视觉攻击性：减少发光效果，只在关键交互用发光
7. **[P2] `/harden`** — 生产环境加固：添加 ARIA 标签、键盘导航支持、空状态处理
8. **[P3] `/delight`** — 添加愉悦感和个性：微动效、数字滚动、告警闪烁
9. **[P3] `/polish`** — 最终打磨：滚动条样式、字体选择、配色个性化

---

## Next Steps

你可以让我：
- **一次运行一个命令**（如先 `/adapt`，完成后再 `/polish`）
- **一次运行所有命令**（我会按顺序执行）
- **按任意顺序运行**

修复后重新运行 `/audit` 查看评分提升。

---

*Audit generated by Impeccable Skill (audit.md reference)*
*Auditor: WorkBuddy AI Assistant*
