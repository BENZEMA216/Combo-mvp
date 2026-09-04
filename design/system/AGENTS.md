# AGENTS.md — Combo 设计系统 agent 规则手册

本文件写给在本仓库工作的 AI agent，覆盖 UI 与设计系统相关的全部硬规则。改任何带样式或组件的代码之前先读完本文件。仓库其余工程约定（目录 README 维护等）见根目录 CLAUDE.md。

## 一、样式规则

组件与页面 CSS 中的颜色、间距、圆角、阴影、字体、动效一律只引用 `var(--cb-*)` 语义 token，禁止出现裸 hex 颜色值和魔法 px 数值。唯一例外是结构性 1px 描边的宽度可以写字面量，但描边的颜色仍然必须是 token。

可用 token 的全量清单在 `packages/ds-tokens/dist/tokens.css`：`:root` 块是 light 模式全量变量，`[data-cb-theme='dark']` 块只列出与 light 有差异的变量。不想解析 CSS 时可以读 `packages/ds-tokens/dist/tokens.flat.json`，它是 light 模式下变量名到最终字面值的扁平映射。

token 的源头是 `packages/ds-tokens/tokens/` 目录下的三份 DTCG 格式 JSON：`primitives.json` 是原料层（色板、字体栈、字号、间距、圆角、阴影、动效裸值），`semantic.json` 是语义层（每个值都是对原料层的纯引用），`motion.json` 是动效语义层。需要新增或修改 token 时改这些 JSON 源文件，然后执行 `npx -y pnpm@11.0.9 -F @cb/ds-tokens build` 重建产物。

`packages/ds-tokens/dist/` 与 `packages/ds/dist/` 都是构建生成物，禁止手改。`packages/ds/dist/styles.css` 由 `packages/ds/scripts/build-css.mjs` 把 src 下所有组件 CSS 按路径字典序汇总生成，组件样式之间不允许存在顺序依赖。

## 二、组件规则

业务代码里的 UI 一律从 `@cb/ds` 导入组件，不要在业务侧手写样式组件；组件样式通过导入 `@cb/ds/styles.css` 一次性引入。组件的 className 前缀是 `cb-`，全部使用 kebab-case（例如 `cb-btn`、`cb-card`）。

组件变体一律用字符串联合枚举 prop 表达（例如 `variant: 'primary' | 'ghost'`），禁止用布尔 prop 堆叠出变体（不允许 `primary`、`large` 这类布尔开关）。组件的全部视觉状态必须可以用不含函数的纯 JSON props 表达，回调 prop 只能作为可选的行为增强，不能是渲染所必需的。

`packages/ds/src/` 当前共有 16 个组件目录，对外导出 20 个组件（外加若干纯函数与类型）。清单与使用场景如下：

| 目录             | 导出组件                             | 何时用                                                                                  |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `avatar`         | `Avatar`                             | 需要显示用户或角色的圆形头像时用，图片缺失或加载失败时自动回退为首字母色块。            |
| `badge`          | `Badge`                              | 需要用小面积软色底在列表行、卡片标题旁标注状态或类别时用。                              |
| `button`         | `Button`                             | 页面上所有可点击操作的统一按钮，带变体、尺寸与加载态。                                  |
| `card`           | `Card`                               | 需要一个纯展示的卡片容器来承载和分组内容时用。                                          |
| `chat`           | `Thread`、`Message`、`Composer`      | 需要渲染会话流时用：消息列表容器、单条消息气泡、自动增高的消息输入框。                  |
| `citation`       | `Citation`                           | 需要在正文中行内标注内容来源（引用编号、来源链接、引文块）时用。                        |
| `dialog`         | `Dialog`                             | 需要模态对话框（二次确认、弹窗表单）时用，基于 @radix-ui/react-dialog 封装。            |
| `empty-state`    | `EmptyState`                         | 列表、收件箱等区域没有内容时的居中占位展示。                                            |
| `input`          | `Input`                              | 需要单行文本、搜索或密码输入框时用，带 label 关联、校验失败态与禁用态。                 |
| `list-item`      | `ListItem`                           | 会话列表、能力列表等纵向列表的单行，带选中态与首尾插槽。                              |
| `markdown`       | `Markdown`                           | 需要把 Markdown 字符串安全渲染成 Combo 样式 HTML 时用（marked 解析加 DOMPurify 消毒）。 |
| `mini-app-shell` | `MiniAppShell`                       | 能力（mini-app）的容器外壳，带标题、运行状态指示与 actions、footer 插槽。             |
| `skeleton`       | `Skeleton`                           | 数据加载期间需要用呼吸动画灰块占住内容位置时用。                                        |
| `text`           | `Text`、`Heading`                    | 正文与标题的统一排版组件。                                                              |
| `timestamp`      | `Timestamp`                          | 需要显示绝对格式或相对格式的时间戳时用。                                                |
| `toast`          | `Toast`、`ToastProvider`、`useToast` | 需要在页面右下角展示自动消失的操作结果通知时用。                                        |

新增组件的流程是固定的：`packages/ds/src/index.ts` 是唯一的 barrel，也是导出合同。先在 `index.ts` 里加上新组件的导出行，再建同名的 kebab-case 目录去实现，目录内文件与导出名不得偏离合同。每个组件目录必须包含四件套：`<组件名>.tsx`（实现）、`<组件名>.css`（样式，只引用 `--cb-*` token）、`<组件名>.stories.tsx`（按 `src/story-types.ts` 的轻量合同导出 `group`，覆盖默认态、边界态、组合态）、`<组件名>.test.tsx`（用 @testing-library/react 断言纯 JSON props 可渲染，另测回调行为）。此外目录里还要有一份中文 README.md，用完整句子写清目录职责与每个文件干什么，只写代码现状。

## 三、能力 UI 规则

runtime agent 给能力（mini-app）输出 UI 时，不直接写 JSX，而是输出符合 `@cb/miniapp-renderer` schema 的组件 JSON。渲染器用 zod 校验输入，把白名单节点映射为 `@cb/ds` 组件树；非法输入降级为错误卡片，绝不执行任意代码。

白名单共 12 个节点：`stack`、`heading`、`text`、`markdown`、`card`、`list-item`、`badge`、`button`、`citation`、`empty-state`、`timestamp`、`skeleton`。字段定义以 schema 文件为准：`packages/miniapp-renderer/schema/miniapp-ui.schema.json`（该路径已在包的 exports 中声明为 `@cb/miniapp-renderer/schema/miniapp-ui.schema.json`）。输出 UI JSON 之前先读这份 schema，不要凭记忆猜节点名和字段。

## 四、禁令

以下写法会直接导致 CI 失败或 review 打回，一条都不要碰：

1. 禁止裸 hex 颜色和魔法 px 数值（结构性 1px 描边宽度除外，描边颜色仍必须是 token）。
2. 禁止 TypeScript 的 `any`。根目录 lint 是 `--max-warnings 0`，`any` 虽然只是 warning 也会挂 CI。类型导入必须用内联形式 `import { type Foo } from 'react'`（consistent-type-imports 规则）。
3. 禁止布尔堆叠的组件变体 prop，变体一律字符串联合枚举。
4. 禁止渐变（gradient）背景与渐变文字。
5. 禁止用 emoji 当图标；图标用内联 SVG 绘制，颜色跟随 `currentColor`。

## 五、验证命令

所有命令在仓库根目录执行，包管理统一用 `npx -y pnpm@11.0.9`：

- 全量构建：`npx -y pnpm@11.0.9 build`；单包构建用过滤器，例如 `npx -y pnpm@11.0.9 -F @cb/ds build`、`npx -y pnpm@11.0.9 -F @cb/ds-tokens build`。
- 全量测试：`npx -y pnpm@11.0.9 test`；单包测试例如 `npx -y pnpm@11.0.9 -F @cb/ds test`。
- lint：`npx -y pnpm@11.0.9 lint`（等价于 `eslint . --max-warnings 0`，任何 warning 都会失败）。
- 类型检查：`npx -y pnpm@11.0.9 typecheck`。
- 格式化：完成改动后对写过的每个文件执行 `npx -y pnpm@11.0.9 exec prettier --write <文件路径>`；CI 侧用 `npx -y pnpm@11.0.9 format:check` 校验。

## Token 的下游视图与单向同步约定

token 的唯一事实源是 `packages/ds-tokens/tokens/*.json`。任何下游视图（`dist/tokens.css`、`dist/tokens.flat.json`，以及未来若建立的 Figma variables 视图）都只能由构建脚本从 JSON 单向生成，禁止在下游改完再倒灌回 JSON——要改 token 就改 JSON 后重新构建。若未来把 token 同步进 Figma，同样遵守「JSON 到 Figma 单向刷新，Figma 页面标注视图勿手改」。

## 强调色上的前景文字

在 `--cb-accent` / `--cb-danger` 这类强调底色上书写文字时，前景色一律使用 `--cb-accent-contrast`（浅色与深色主题下都保证可读），不要用 `--cb-surface-raised` 之类的面色 token 顶替。
