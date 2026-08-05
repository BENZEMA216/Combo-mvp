# modules/agent-project —— Agent 创作聚合

这个模块把能力项、Miniapp 与现有 Runtime 冻结成可持续编辑和发布的 Agent。Project 只保存当前 Head 与当前 Release 两个可变指针；Revision 和 Release 不可变，发布必须引用同一 Revision 的真实 Runtime Test。

## 文件

- `routes.ts` 声明 Project 创建、列表、详情、Revision 保存与读取、Release 创建六个端点。写请求先验证精确浏览器来源，再验证不透明 Cookie 会话。
- `handlers.ts` 校验共享请求契约、映射并发与编译失败、返回统一响应信封，并在每次写入后重新读取 Project。
- `service.ts` 计算幂等摘要和稳定 Revision ID，编排编译、Revision CAS、对象完整性回读与 Release 发布。
- `compiler.ts` 读取并冻结完整 Capability 定义和合规 Studio HTML，先编译检查 structured JSON Schema，再生成不可变定义文档与单循环 Runtime Bundle。对象键包含内容 SHA-256，因此同一 mutation ID 的冲突正文不会互相覆盖。
- `repo.ts` 收拢 Agent 四表 SQL。保存 Revision 时锁定 Project 并用 `expectedHeadRevisionId` 做 CAS；创建 Release 时核对通过的 Test、Revision、Runtime Bundle 摘要和 UI 摘要。

## 上下游

本模块依赖 task 的来源任务、capability 的定义对象、Runtime 写出的 Studio Artifact，以及 `@cb/shared` 的 Agent 契约。Runtime 只读取这里编译出的不可变 Bundle，不在运行时重新拼装当前 Capability 或当前 UI。大定义与 Bundle 以内容寻址键存在 `combo-artifacts` 桶，PostgreSQL 只保存对象键、摘要和生命周期关系；对象存储暂时不可用会作为依赖故障返回，不伪装成用户定义无效。
