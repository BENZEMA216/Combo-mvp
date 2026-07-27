# modules/artifact —— 产物

这个目录负责产物（模型产出的可独立留存成品，如网页、文档、代码、结构化数据）。它给模型提供写产物的工具，也给前端提供回读产物内容的端点。产物元数据存入 `artifacts` 表，正文存入对象存储。同一个产物仍原地更新一条索引行，但每次正文先写入新的不可变对象键。

## 文件

- `routes.ts` 声明本模块唯一的端点：GET /runtime/artifacts/:id/content，挂 requireAuth 鉴权守卫。
- `handlers.ts` 实现内容回读处理器：先按当前用户做归属校验查出产物行，再从对象存储读回正文，按产物种类设置正确的 Content-Type 返回。
- `repo.ts` 封装 `artifacts` 表和 Capability 当前 UI 指针的 SQL。它负责把工具产物关联到来源 Turn、按 Turn 终态恢复 Studio revision 历史、插入或原地更新索引行、复制 UI 隔离副本、采用同一创作者既有的合规 consume UI，并通过 `sessions` 表校验内容读取归属。数据库复合外键同时保证 Artifact 与来源 Turn 属于同一 Session。它还定义桶名、不可变正文对象键和内容类型映射。模型工具提交索引前会按固定锁序确认绑定 Turn 仍为 `running`。UI 副本写入先在事务外保存不可变候选对象，再锁定并校验目标 Session 的 capability、owner、mode 和 active 状态，并在锁内复查已有 HTML；并发进入只落一条 seed 索引，失败或竞争落败最多留下可离线清理的孤儿对象。
- `studio-contract.ts` 校验 Studio HTML 是完整自包含文档，包含真实 `combo:run` bridge，并拒绝定时器、随机数和模拟结果。
- `tool.ts` 定义暴露给模型的 `upsert_artifact` 工具。工具先用中止信号写入不可变暂存对象，再调用仓储条件提交带来源 Turn 的索引。Turn 已终态或请求已经中止时，暂存对象不会变成可见 Artifact，也不会触发产物更新事件。普通 Session 只在产物编号属于本会话时更新索引；Studio 每次都创建新的合规 HTML revision。

## 上下游

被谁使用：`bootstrap/routes.ts` 注册本模块路由；`modules/agent/run-turn.ts` 在每轮生成时用 `tool.ts` 建产物工具，并在 Studio 成功终态提升当前 UI；`modules/session/handlers.ts` 使用 `repo.ts` 返回产物列表、恢复 Studio 页面和给新普通 Session 创建 UI 隔离副本。

依赖什么：引用 `platform/infra/db.ts` 的数据库句柄类型和 `platform/infra/object-store.ts` 的对象存储接口，引用 `platform/middleware/auth.ts` 的鉴权守卫，引用 `platform/http/_helpers.ts` 的错误信封工具，引用 `modules/session/repo.ts` 的时间格式化函数。直接访问的外部资源是数据库的 `artifacts`、`sessions` 和 `capabilities` 表，以及对象存储的 `combo-artifacts` 桶。

## 典型流程

以「前端回读一个产物的内容」（GET /runtime/artifacts/:id/content）为例：

1. 请求经 `routes.ts` 声明的端点进来，requireAuth 守卫先验登录态并把用户身份挂到请求上。
2. `handlers.ts` 的处理器调 `repo.ts` 的 readArtifactForOwner，用产物 id 连表 sessions 查行并校验会话归属；非本人或不存在都返回 404，不区分两种情况。
3. 处理器用查到的存储键从对象存储读回正文文本；对象存储不可用时返回依赖不可用的错误信封。
4. 按产物种类映射 Content-Type（如 html 对应 text/html），把正文以 200 直接返回，前端据此在画布里渲染或嵌入沙箱预览。
