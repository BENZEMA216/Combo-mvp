# modules/capability —— 能力的列表与加载

这个目录负责把创作端做好的能力提供给试用端：列出当前用户可试用的能力，以及在开会话、发消息前加载并校验某个能力的完整可运行定义。能力的轻量索引存 capabilities 表，完整定义 JSON 存对象存储。

## 文件

- `routes.ts` 声明本模块唯一的端点：GET /runtime/capabilities，挂 requireAuth 鉴权守卫。
- `handlers.ts` 实现能力列表处理器，并导出 sendLoadFailure 函数，把加载器的各种非成功结果统一映射成对外错误信封（不存在按 404，格式过新按冲突并配可读提示，定义损坏按 500）。
- `loader.ts` 是核心加载逻辑：先查 capabilities 表做发布可见性闸，再从对象存储读原始 JSON。legacy v1 按共享 schema 校验，并显式拒绝混入 `protocol` 或 `release` 的 hybrid；Capability v2 必须是 canonical `combo.agent-package-capability/2` 投影，不能先 `JSON.parse` 后宽松重建。另外提供试用列表和会话详情摘要查询。

## 上下游

被谁使用：`bootstrap/routes.ts` 注册本模块路由；`modules/session/handlers.ts` 在创建会话时加载 Capability。v1 继续直接执行；v2 交给 `knowledge-agent/resolver.ts` 核对 Registry 与 exact Package，然后把绑定冻结进 Session。后续发消息只允许当前解析结果与 Session 冻结值完全一致，不会用可变 Capability 切换产品真源。

依赖什么：引用 `platform/infra/db.ts` 的数据库句柄类型和 `platform/infra/object-store.ts` 的对象存储接口，引用 `platform/middleware/auth.ts` 的鉴权守卫和 `platform/http/_helpers.ts` 的错误信封工具，引用 `modules/session/repo.ts` 的时间格式化函数，能力定义的 schema 来自共享包 @cb/shared。直接访问的外部资源是数据库的 capabilities 表和对象存储的 combo-artifacts 桶。

## 典型流程

以「用户打开试用入口拉能力列表」（GET /runtime/capabilities）为例：

1. 请求经 `routes.ts` 声明的端点进来，requireAuth 守卫验登录 Cookie 并查 users 表，把用户 id 挂到请求上。
2. `handlers.ts` 的 listCapabilitiesHandler 调 `loader.ts` 的 listTrialCapabilities。
3. listTrialCapabilities 对 capabilities 表执行一条查询：取「我拥有的全部」加「别人已发布的」，按创建时间从新到旧最多取一百条。
4. 每行被整理成列表项，其中 owned 字段标记是否本人创作，供前端分组展示；处理器把数组包进带 traceId 的响应信封返回 200。
