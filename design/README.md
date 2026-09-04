# design — Combo 设计交付物快照

这个目录存放 Combo 设计侧的交付物，来源是设计交接包 combo-design-handoff 的 2026-07-13 对账更新版（2026-07-15 收到）。这一版做过设计稿与实装的全面对账：名词统一为「能力」（旧词「经验体」退役），创作侧设计卡照 `apps/web` 真实代码重画。全部是纯静态资料，不在 pnpm workspace 之内，不参与构建和部署。

## 各子目录与文件

- `ONBOARDING.md`：开发者上手指南，规定了这套材料的阅读顺序，并带一份「实装待修清单」（设计已定稿、实装尚未追上的差距，按性价比排序）。
- `prototype/`：占卜消费流的可交互原型 `oracle-flow.html`。它是自包含单文件（内联 CSS 和原生 JS），用浏览器直接打开即可运行，顶部带原型调试条；同目录的 README 说明调试条用法和每个演示态对应的设计决策。原型演示的位置态机、@指向等是目标 spec，实装还没有。
- `ds-cards/`：33 张自包含 HTML 设计卡（含总览 `index.html`）加品牌资产（`assets/`）。分组为基础（foundations）、品牌（brand）、组件（components）、对话框系统与页面（pages）、对比（compare）。页面组里，消费运行时四张和对话框系统两张是目标 spec；创作侧四张（上传任务页、任务详情、能力挑选、我的能力页）是 `apps/web` 实装镜像，可直接当参考；货架六张（shelf-a 至 shelf-f）是消费端市集的风格方向探索，未定稿。它是 Claude Design 在线面板的离线快照。
- `system/`：设计系统契约。`AGENTS.md` 是给开发 agent 的规则手册（token 用法、组件清单、能力 UI schema、禁令、验证命令），`design-taste.md` 是品味守则和视觉硬禁令（本版修正了旧文里三处写错的字号与圆角阶梯），`tokens/` 是密度定稿的 token 契约快照，含原料层 `primitives.json`、语义层 `semantic.json`、动效 `motion.json` 和构建产物 `tokens.css`（产物文件不可手改）。

## 真源与边界

- 设计决策记录（DEC-01 至 DEC-43）与设计系统总纲**不入仓**，真源在飞书。决策文档见 [Combo 设计决策记录](https://zcndjgnt0026.feishu.cn/docx/D1qEdfDQ8oV4i2xeWgycEnPbnY4)；总纲（含伴随对话框六层处理模型）在飞书设计侧文档，与决策文档同处维护。项目整体的 PRD 与技术方案真源见仓库根 README 的「文档真源」一节。
- 可构建的设计系统包（`@cb/ds-tokens`、`@cb/ds`、`@cb/miniapp-renderer`）目前在 `ds/agent-ready-v1` 分支上，远程分支的 token 值经实测仍是更早的「活力红橙」版本，落后于本目录；将来包化或合并该分支时，token 取值一律以 `system/tokens/` 的密度定稿值为准。
- `system/AGENTS.md` 里的样式约束（只准引用 `--cb-*` 语义 token）面向接入设计系统后的前端；消费侧 `apps/runtime-web` 尚未接入，现阶段对它仅作契约参考。
- 名词「经验体」已退役，但 `ds/agent-ready-v1` 分支的仓根 AGENTS.md、CLAUDE.md 与 design-taste skill 里仍有残留，待那边同步。
