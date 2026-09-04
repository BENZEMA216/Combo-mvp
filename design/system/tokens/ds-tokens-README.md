# @cb/ds-tokens

本包是 Combo 设计系统 token 的单一事实源。此前 `--cb-*` 变量的 canon 手工维护在 apps/web/src/styles.css 与 apps/runtime-web/src/styles.css 的 `:root` 块里并要求逐值同步，本包把这份 canon 接管为 DTCG 格式（每个 token 用 `$type` 与 `$value` 描述）的 JSON 文件，经 style-dictionary v4 构建出可直接引用的 CSS 变量文件与扁平 JSON 映射。两个前端 app 现在都在入口 main.tsx 直接 `import '@cb/ds-tokens/tokens.css'` 消费本包的构建产物，各自 styles.css 的 `:root` 里已不再自存一份 `--cb-*`（runtime-web 只保留 app 独有的 `--rt-sidebar-w`），本包的 dist 是这些变量的唯一源头。

## 目录与文件

- `tokens/` 存放三份 token 源 JSON（原料层、语义层、动效语义层），详见该目录的 README。
- `build.mjs` 是构建脚本，读取三份 JSON，解析全部 `{}` 引用与 light/dark 双模式取值，然后通过 style-dictionary 输出 `dist/tokens.css` 与 `dist/tokens.flat.json`。语义 token 的 CSS 变量命名规则固定：语义 key 前面加 `--cb-`，例如语义 key `paper` 输出变量 `--cb-paper`。
- `scripts/` 存放两个构建期校验脚本（语义层纯引用校验、双模式齐备校验），详见该目录的 README。
- `__tests__/` 存放 vitest 测试（构建幂等测试，以及断言两个 app 入口都 import 了 tokens.css 的消费链路测试），详见该目录的 README。
- `dist/` 是构建产物目录，不入库、不允许手改。`tokens.css` 的 `:root` 块输出 light 模式全量 68 个 `--cb-*` 变量，`[data-cb-theme='dark']` 块只输出与 light 有差异的 25 个变量；`tokens.flat.json` 是 light 模式下「变量名到最终字面值」的扁平映射，所有引用（包括 `var()` 别名与 color-mix 配方内嵌的引用）都已完全内联成字面值，供不解析 CSS 的消费方（例如代码生成工具）直接读取。

## token 分三层

第一层是原料层（`tokens/primitives.json`），存放裸值：墨色阶（ink）、中性纸白阶（paper）、暖中性灰阶（neutral）、砖红阶（brick）、聚焦灰绿（sage）、绿（green）、赭黄（amber）、红（red）等色板，字体族栈，字号阶梯，间距阶梯，圆角刻度，阴影，动效时长与缓动曲线。当前主题为「品牌砖红主色 × 暖纸画布」：accent 于 2026-07-11 定稿为品牌砖红 #a73718（DEC-31），取代此前短暂试用的活力红橙 #f15f43，light 模式全部取值与消费页 mock 验证过的官方品牌值一致。

尺寸/间距类原料层于 2026-07-12 做了密度定稿（产品密度，约 -15%，DEC-43），对齐已在交互原型里验证过的尺度，只改尺寸/间距不动颜色：字号阶梯收紧为 11/12/13/14/18/24/32 像素（xs→3xl），间距阶梯 1=4、2=8 保留，3-8 收紧为 10/14/20/26/32/40 像素，圆角 card 8→7、hero 18（control 6、pill 999 保留），结构宽度 sidebar-w 288→256、dialog-w 480→440、thread-w-md 40rem→36rem、thread-w-lg 52rem→46rem（focus-ring/indicator/bar 等 1-3px 结构描边保留）。

第二层是语义层（`tokens/semantic.json` 与 `tokens/motion.json` 合并构成），每个 token 的 `$value` 都是形如 `{xx.yy}` 的纯引用，不允许出现任何裸值。语义 key 与 canon 变量一一对应（例如语义 key `paper` 对应 canon 的 `--cb-paper`），并新增了 canon 里没有的 `space-1` 到 `space-8`、`text-xs` 到 `text-3xl`、`duration-*` 与 `ease-*`。

第三层是构建产物（`dist/`），由 `build.mjs` 生成。

## 两类特殊的语义 token

第一类是别名：`border` 引用 `{semantic.line-1}`，`badge-ok` 引用 `{semantic.ok}`，构建时输出成 `var(--cb-line-1)` 这样的 CSS 变量引用，暗色模式下随被引用变量自动切换，因此它们不需要单独的 dark 值。

第二类是 color-mix 配方：`ok-soft`、`warn-soft`、`danger-soft`、`danger-line` 四个软底色引用原料层 `color.mix` 组里的配方字符串。配方字符串里嵌着 `{semantic.ok}` 这类语义引用，构建时输出成 `color-mix(in srgb, var(--cb-ok) 10%, var(--cb-surface))`。因为语义层只允许纯引用，配方字符串本身（含 10% 这类混合比例）放在原料层的 `color.mix` 组里。配方在暗色模式下随 `var()` 指向的变量自动重算，同样不需要单独的 dark 值。

## 双模式（light/dark）

每个非别名、非配方的 color 语义 token（以及三个 shadow token）的 `$value` 是 `{ "light": "{...}", "dark": "{...}" }` 形态的对象，两个模式各给一个引用。**dark 值是提案，尚未经人工调校**：纸感反转成墨底（paper 落在 #1a1917 一系的暖墨色阶上）、前景色反转成暖白、accent 换成提亮的砖红（#c85a36 一档）、soft/tint 转为深棕、分隔线转为深中性灰、ok/warn/danger 提亮到暗底可读，后续视觉走查时按需要直接改语义层的 dark 引用或原料层色阶即可。

## 动效 token 放在独立文件

动效语义 token（`duration-fast`、`duration-base`、`duration-slow`、`ease-standard`、`ease-decelerate`）放在 `tokens/motion.json`，没有并入 `tokens/semantic.json`。这份文件在构建与校验时都和 `semantic.json` 合并当作同一个语义层处理，两个校验脚本会同时扫描这两份文件。

## 构建、校验与测试

`pnpm -F @cb/ds-tokens build` 依次执行构建脚本与两个校验脚本；`pnpm -F @cb/ds-tokens test` 运行 vitest。测试包含构建幂等断言（连跑两次 build，dist 产物哈希一致），以及消费链路断言（读取两个 app 的入口 main.tsx，确认都 import 了 `@cb/ds-tokens/tokens.css`）。

## 消费方式

包通过 `exports` 暴露两个产物：`@cb/ds-tokens/tokens.css`（CSS 变量文件）与 `@cb/ds-tokens/tokens.flat.json`（扁平映射）。消费方在 HTML 根元素上设置 `data-cb-theme='dark'` 即切换暗色变量。
