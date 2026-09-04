---
name: design-taste
description: Combo 品牌品味守则。在本仓库写任何 UI 组件、改任何 CSS/样式、生成能力（mini-app）界面、或 review 涉及颜色/字体/圆角/阴影/间距/动效的 diff 之前，必须先读本文；所有视觉决策以本文为准，与直觉冲突时以本文为准。
---

# Combo 设计品味守则

Token 单一事实源：`packages/ds-tokens/dist/tokens.css`（生成物，改 token 去 `packages/ds-tokens/tokens/*.json`）。本文只讲「怎么用才像 Combo」，token 值本身以那份文件为准。

## 品牌一句话

Combo 是一张摊在暖白纸面上的工作底稿：墨字、细格线、一点砖红图章。

## 五条核心气质

1. **纸感**：底色永远是暖纸系（`--cb-paper` / `--cb-bg` / `--cb-surface` / `--cb-surface-raised` 四级面），像印刷品，不像发光的 dashboard。
2. **墨字**：正文与标题用近黑墨色 `--cb-fg`（#1c1b19），次要信息用 `--cb-muted`；不存在纯黑 #000，也不存在中性灰 #888。
3. **砖红是图章不是涂料**：`--cb-accent`（#a73718）只盖在最重要的一两处；面积一大就俗。
4. **编辑部字体**：衬线（Noto Serif SC / 字标 Fraunces）管标题与品牌时刻，无衬线管正文与功能文字，等宽（Geist Mono）管 label、时间戳和数据。
5. **轻**：层次靠三级细线（`--cb-line-1/2/3`）、48px 网格纸底纹（`--cb-grid`）和留白，不靠色块和重阴影；阴影淡到「怀疑没开」才对。

## 品牌标识（Combo. 字标）——固定资产，独立于 UI

品牌标识是**锁定的固定资产**，不是可以跟着主题走的 UI 元素。它有自己的一套颜色，**永远不随 UI 强调色变化**。

- **主字标**：双色「Combo.」，字体 **Fraunces Black**。`Com` 用墨 `#1C1B19`，`bo` 与句点用**砖红 `#A73718`**，句点对齐 `o` 基线。反白版：`Com` 用纸白 `#FBFAF6`，`bo.` 仍砖红。图标版：墨色圆角方块 + 反白 `C` + 砖红句点。
- **关键铁律：字标的砖红是品牌色，不是 `var(--cb-accent)`。** 即便 UI 强调色被换成别的红（珊瑚等探索版），字标的 `bo.` 仍是砖红 `#A73718`。**禁止**用 `var(--cb-accent)` 给字标上色、禁止「换肤时顺手把字标一起换色」——那是把品牌标识和 UI 强调色搞混了。
- **禁止用 CSS 文字冒充字标**：`<span style="font-family:serif">Combo.</span>` 在没有 Fraunces 时会回退成宋体/普通衬线，丢掉 Fraunces Black 的招牌字形，读起来「不像 Combo」。字标一律用**矢量资产**（`ds-cards/assets/combo-wordmark.svg` 或 app 内的品牌组件内联 SVG），不用可回退的字体文字。
- **用法**（源自定稿规范）：安全间距 ≥ 字母 `o` 的高度；数字端最小宽度 ≥ 88px；勿改双色顺序、勿加描边阴影、勿拉伸。

## 硬禁令（review 逐条对照，违反即打回）

每条格式：bad → good。

1. **禁渐变按钮/渐变文字/渐变卡片**：`background: linear-gradient(135deg, #a73718, #ff8a5c)` → `background: var(--cb-accent)`。全仓 `linear-gradient` 唯一合法用途是网格纸底纹（1px `var(--cb-grid)` 线 + `background-size: 48px 48px`）。
2. **禁 emoji 当图标**：`<span>🔥</span>` 做按钮/状态/导航图标 → 内联 SVG，`stroke="currentColor"`，颜色由 `var(--cb-fg)` / `var(--cb-muted)` / `var(--cb-accent)` 继承。emoji 只允许出现在用户生成内容原文里。
3. **禁彩虹语义色**：引入 #7c3aed 紫、#0ea5e9 蓝、#f59e0b 橙表示状态或分类 → 状态只有 `var(--cb-ok)` / `var(--cb-warn)` / `var(--cb-danger)` 三个，强调只有 `var(--cb-accent)` 一族；「信息蓝」在本仓不存在。
4. **禁字号自由值**：`font-size: 15px`、`font-size: 1.1rem`、`font-size: 18px` → 只准 `var(--cb-text-xs/sm/md/lg/xl/2xl/3xl)`（对应 11/12/13/14/18/24/32，密度定稿值）；15、22、30 不在阶梯上，就是不存在。
5. **禁大面积砖红**：整卡 `background: var(--cb-accent)`、通栏红 banner → accent 面积预算：一屏至多 2 处强实心砖红（主按钮、徽标点这个量级）；需要红色底只准 `var(--cb-accent-soft)` / `var(--cb-accent-tint)`。
6. **禁圆角混用**：`border-radius: 4px / 10px / 12px / 16px / 20px` → 只有四档：控件 `var(--cb-radius-control)`（6，按钮/输入框）、卡片 `var(--cb-radius-card)`（7）、品牌大块 `var(--cb-radius-hero)`（18）、胶囊 `var(--cb-radius-pill)`（999）；四档之外无值。
7. **禁重阴影**：`box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3)` → 只有三档 `var(--cb-shadow-surface)`（卡片默认）/ `var(--cb-shadow-hero)`（品牌区）/ `var(--cb-shadow-overlay)`（浮层专用）；不许自写 rgba 阴影。
8. **禁裸色值与魔法 px**：`color: #333`、`padding: 18px` → 颜色一律 `var(--cb-*)`，间距一律 `var(--cb-space-1..8)`（4/8/10/14/20/26/32/40，密度定稿值）；唯一例外是结构性 1px 描边宽度，且描边颜色仍必须是 token（如 `1px solid var(--cb-border)`）。
9. **禁自由动效值**：`transition: all 0.3s ease` → 时长只准 `var(--cb-duration-fast/base/slow)`（120/200/320ms），缓动只准 `var(--cb-ease-standard)` / `var(--cb-ease-decelerate)`。
10. **禁布尔变体堆叠**：`<Button primary large>` → `<Button variant="primary" size="lg">`；组件变体一律字符串联合枚举，全部视觉状态可用纯 JSON props 表达。

## 组合规范

### 衬线 vs 无衬线

- 用衬线 `var(--cb-font-serif)`：页面标题（`cb-page__title`）、卡片标题（`cb-card__title`）、hero/空态的品牌句、能力名称等「内容性标题」。
- 用无衬线 `var(--cb-font-sans)`：正文、表单 label、按钮文字、导航项、表头等一切「功能性文字」。
- `var(--cb-font-brand)`（Fraunces，weight 900）只用于 Combo 字标与徽标，不用于任何普通标题。

### 等宽字体的三个合法用途（仅此三个）

1. 分类/类型 label（如列表项的 kind 标签，`var(--cb-text-xs)` + `var(--cb-muted)`）。
2. 时间戳与日期。
3. 数据值：配对码、命令行、ID、计数、指标数字。

正文、标题、按钮文字永远不用 mono。

### 留白节奏

- 相邻区块之间的间距从 `var(--cb-space-6)`（26px）起步，页面级分段可到 `var(--cb-space-7/8)`（32/40px）。
- 卡片内 padding 用 `var(--cb-space-4)`（14px），标题与正文之间 `var(--cb-space-2)`。
- 紧凑元素（图标与文字、胶囊之间）间隙用 `var(--cb-space-2)`，最小 `var(--cb-space-1)`。

### 状态色

只从 ok / warn / danger 三个语义取：文字与图标用 `var(--cb-ok/warn/danger)`，底色用对应的 `var(--cb-ok-soft/warn-soft/danger-soft)`，危险描边用 `var(--cb-danger-line)`。「成功用砖红」「提示用蓝色」都是错的；焦点态一律 `var(--cb-focus-ring)`。

## 判断口诀

- 像 Combo：暖纸墨字细格线，一点砖红当图章。
- 不像 Combo：渐变玻璃圆角卡，彩灯闪成仪表盘。
