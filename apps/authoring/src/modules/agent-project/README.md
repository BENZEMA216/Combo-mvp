# modules/agent-project —— Agent 创作聚合

这个模块把能力项、Miniapp 与现有 Runtime 冻结成可持续编辑和发布的 Agent。Project 只保存当前 Head 与当前 Release 两个可变指针；Revision、Test Review 和 Release 不可变，发布必须引用同一 Revision 的技术通过 Test 与可发布质量复核。

## 文件

- `routes.ts` 声明 Project 创建、列表、详情、Revision 保存与读取、Test Review 保存和 Release 创建七个端点。写请求先验证精确浏览器来源，再验证不透明 Cookie 会话。
- `handlers.ts` 校验共享请求契约，映射并发、编译、复核与发布失败，返回统一响应信封，并在 Project 与 Release 写入后重新读取权威状态。
- `service.ts` 计算幂等摘要和稳定 Revision ID，派生质量复核结论，并编排编译、Revision CAS、对象完整性回读、复核保存与 Release 发布。
- `compiler.ts` 读取并冻结完整 Capability 定义和合规 Studio HTML，先编译检查 structured JSON Schema，再生成不可变定义文档与单循环 Runtime Bundle。对象键包含内容 SHA-256，因此同一 mutation ID 的冲突正文不会互相覆盖。
- `repo.ts` 收拢 Agent Project、Revision、Test Review 与 Release SQL。保存 Revision 时锁定 Project 并用 `expectedHeadRevisionId` 做 CAS；复核写入时锁定 Project、验证 owner 和技术 Test，并冻结 Revision、Runtime Bundle、UI、复核用户与案例摘要。创建 Release 时再次核对 Test、Review、当前 Head 和全部摘要。
- `repo.test.ts` 用事务假件验证复核创建、同正文重放、异文冲突、单 Test 不可变性、技术 Test 门禁、完整证据摘要和 Release 复核冻结。

## 上下游

本模块依赖 task 的来源任务、capability 的定义对象、Runtime 写出的 Studio Artifact 与技术 Test，以及 `@cb/shared` 的 Agent 契约。Runtime 只读取这里编译出的不可变 Bundle 和质量复核状态，不在运行时重新拼装当前 Capability 或当前 UI。大定义与 Bundle 以内容寻址键存在 `combo-artifacts` 桶，PostgreSQL 只保存对象键、摘要和生命周期关系；对象存储暂时不可用会作为依赖故障返回，不伪装成用户定义无效。
