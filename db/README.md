# db PostgreSQL 迁移

这个目录是数据库结构的唯一真源。当前迁移链从 `0000` 连续到 `0028`，已经执行的迁移保持原样；第一方邮箱认证、应用数据库角色、共享 Agent 计费与 Creator-hosted Agent VNext 只通过后续迁移追加。

## 迁移文件

- `0000_baseline_schema.sql` 创建用户、任务、上传、能力、会话、消息、产物和模型审计基线，并提供 UUID v7 函数。
- `0001_expired_upload_reconciliation.sql` 增加上传过期状态和清理索引。
- `0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表；运行事件与回放只使用 Redis Stream。
- `0003_turns.sql` 创建自治 Turn，并让 Message 与 Artifact 关联同一 Session 内的来源 Turn。
- `0004_studio_sessions.sql` 增加 consume 与 studio 两种 Session 模式，并限制同一 owner 和 Capability 只有一个 active Studio Session。
- `0005_capability_current_ui.sql` 增加 `capabilities.ui_artifact_id`，保存当前 Studio UI Artifact 指针。
- `0006_one_running_turn_per_session.sql` 拒绝历史重复 running Turn，再建立单 Session 单运行 Turn 的部分唯一索引。
- `0007_first_party_email_auth.sql` 只允许空用户库切换到第一方邮箱验证码，删除旧外部身份列，并创建身份、挑战、不透明会话和低敏认证审计表。
- `0008_application_database_roles.sql` 创建 API、worker 与 runtime 三个无登录角色，撤销默认权限并按当前业务职责授予最小权限。
- `0009_billing.sql` 创建全局钱包、按用户与 Agent 隔离的免费额度、使用预留、充值订单、支付尝试、低敏回调事件和不可变资金流水，并补充计费最小权限。
- `0010_recharge_qr_channel.sql` 把扫码充值通道从聚合码 `aggregate_qr` 重命名为 C扫B 单渠道 `qr`（`/v3/prepay`），并把历史 `aggregate_qr` 订单一并迁移到 `qr`。
- `0011_recharge_qr_only.sql` 移除 H5「手机收银台」渠道，把历史 `h5` 订单迁到 `qr`，并把支付方式约束收窄为只允许 `qr`。
- `0012_creator_hosted_agent_vnext.sql` 创建不可变 Context Snapshot 与 AgentVersion、Deployment/Worker Lease、版本固定的 Consumer Conversation、消息级 AEAD 对话、Invocation/Event Journal 和事务 Outbox，并为 VNext API、Broker 与 Reconciler 创建相互隔离的数据库角色和强制租户 RLS。
- `0013_creator_agent_consumer_create.sql` 以 expand-only 升级加入邀请制 Agent Access Grant、Conversation create 幂等键、exact Lease/Fence definer 与 Consumer 最窄 RLS；它不会启用公网路由。
- `0014_creator_agent_consumer_open_ready.sql` 新增独立 `combo_agent_consumer_api` 登录边界，并以窄 definer 原子写入 `OPENING + conversation.open`、只接受 exact current Lease/Fence/Worker 的 durable `conversation.ready` 后转 `IDLE`。
- `0015_creator_agent_gateway_authority.sql` 增加一次性 Worker Challenge、持久 Session/sequence/ACK/outbound receipt、安全事件、短 Lease 与 exact grant correlation，并以窄 API/Broker authority、强制 RLS 和事务 receipt 支撑 Gateway 崩溃恢复。
- `0016_creator_agent_invocation_lifecycle.sql` 增加 exact prepare/start Broker command、Execution Capability 与 Worker Invocation durable fact authority。
- `0017_creator_agent_conversation_ready_fact.sql` 增加跨重连可重放的完整 `conversation.ready` durable fact authority。
- `0018_creator_agent_broker_delivery_contract.sql` 在 zero-live cutover 后安装 Broker payload v1、visible-transcript KMS HMAC metadata、原始 assignment/current delivery 双 authority、跨 Session 稳定 business `messageId` 与 create-open-v2；历史 v0 business 不可 claim，`lease.revoke` 等 protocol control 继续以全局唯一 `messageId` 的 exact v0 frame 持久化。
- `0019_creator_agent_broker_outbox_publisher.sql` 为默认关闭的 Test-only `conversation.open` publisher 固定不可变 wire 时间、严格 operation receipt、replacement pre-ACK identifier receipt 与 current Session/Lease claim 约束；PERSISTED 不 ACK Outbox，只有 ready projector 收敛终态。它不启动 Gateway，也不允许 Preview 或 Production delivery。
- `0020_creator_agent_confirmed_failure_fact.sql` 只扩展 canonical Worker `invocation.failed` fact 的 durable digest/source binding，并把可公开的 confirmed failure code 收窄到固定 registry。它不启用 Invocation runtime；由于还没有受验证的 interrupt receipt authority，`invocation.cancelled` 继续 fail closed。
- `0021_creator_agent_context_admission.sql` 以窄 SECURITY DEFINER 原子执行 USER Message admission、Conversation BUSY/next-turn projection或 context-limit suspension，并撤销 API 对这些写点的 direct column authority。它按 pinned RuntimePolicy、连续 USER 事实及 AES-GCM ciphertext octets执行 ADR-VNEXT-006 的下一条 USER admission；fresh ASSISTANT overflow策略与完整 ADR/SCH-004仍未完成。这是 Test-only quiescent exact-tuple cutover，不实现 HTTP send route。
- `0022_creator_agent_consumer_message_accept.sql` 为 direct-login `combo_agent_consumer_api` 增加唯一的 Consumer message full-accept definer。Runtime 先分配 USER Message UUIDv7 并完成未来 KMS sealing；数据库在同一事务内生成 Invocation、accepted Event、prepare Outbox 的 UUIDv7 和 Cloud deadline，复用 0021 admission core，并以 replay、conflict、context-limit 和 unavailable 稳定结果收敛。ADR-VNEXT-033 要求 HTTP fresh Consumer key 为 canonical lowercase UUIDv4；Message text authority同时检查canonical形式与版本，Conversation的PostgreSQL uuid trigger只能在类型规范化后检查版本位。已有bounded legacy key只在durable row命中后replay/conflict。Fresh accept还要求Version未发生安全撤销、Deployment/Worker observed online且当前Lease/Gateway留有安全窗口。Consumer仍没有业务表直接写权，也不能执行private core或API wrapper；该迁移不实现KMS、HTTP route或Broker dispatch。
- `0023_creator_agent_event_integrity.sql` 为 reconciliation Event 链增加显式 `invocation.reconciling_resumed` 事件，并新增低敏、append-only、FORCE-RLS 的 Journal integrity alert authority。Root/resumed trigger把Broker/Reconciler session、既有Worker fact、reason、journal sequence和deterministic source identity精确绑定；deferred companion constraint也会在提交前拒绝旧binary产生的无root/无resume投影。该cutover要求quiescent upgrade，zero-legacy门还拒绝可确定的活动及UNCERTAIN历史缺口；无法无歧义识别的旧terminal history仍不回填。完整 Event fold、projection digest parity、冲突后 durable alert 接线与恢复审计仍未实现，不能据此关闭测试方案 10.6。
- `0024_creator_agent_reconciliation_source_admission.sql` 把explicit Reconciler root的fresh admission、exact replay与global logical source冲突收进一个最窄`SECURITY DEFINER`。函数在读取全局source前验证exact session/tenant，按logical UUIDv7取得全局advisory lock，再锁incoming Invocation/Conversation；同source不同canonical body只向incoming tenant写一条低敏deduplicated alert并返回`SECURITY_BLOCKED`，不改变业务projection。归一化唯一索引同时覆盖direct、`late-prepared:`与`late-started:`别名；旧Reconciler binary的direct explicit INSERT由root trigger拒绝。该迁移只接线begin-reconciliation source conflict，不实现其他Event类型、完整reducer/parity或alert审计生命周期。
- `0025_creator_agent_prepared_fact_admission.sql` 将`invocation.prepared` Worker fact的global source锁、单Invocation phase锁、跨RLS full-field compare、fresh persisted Event与prepare ACK、exact replay和conflict alert统一进Broker-only definer。数据库按冻结JCS字段独立重算fact digest；旧Broker direct persisted Event writer由trigger拒绝。`SECURITY_BLOCKED`由Gateway外层继续提交frame/operation receipt与Cloud ACK；start command和late reconciliation仍在同一外层事务的Cloud projector后半段完成。
- `0026_creator_agent_started_fact_admission.sql` 将`invocation.started` Worker fact的JCS digest、global source/started phase classifier、RUNNING或RECONCILING projection、started Event、双attestation component、可选late-started root及start ACK全部收进Broker-only definer。旧started历史因缺dispatch/sandbox component无法安全回填，迁移在锁内zero-legacy fail closed；旧Broker direct started writer由trigger拒绝。
- `0027_creator_agent_failed_fact_admission.sql` 将confirmed `invocation.failed` fact、FAILED projection、Worker Event、Consumer terminal payload/digest/dedupe/cursor、stream、永久低敏receipt与Conversation IDLE收进Broker-only definer。Receipt在Outbox retention删除后继续证明原cursor；迁移zero-legacy拒绝旧confirmed failed终态，旧Broker direct failed Event与failed Consumer Outbox写入均fail closed。
- `0028_creator_agent_success_fact_admission.sql` 以同一外层事务中的preflight/seal/finalize两阶段协议接管`invocation.succeeded`：数据库先锁定全局source与Invocation并分配Assistant Message ID/AAD，外部authority完成sealing后，finalize重验Cloud时钟与事实绑定，再原子写入Message、SUCCEEDED projection/Event、Consumer Outbox/stream、永久receipt与Conversation IDLE。Transient preflight必须同事务消费；旧Broker direct Assistant/Success Event/Outbox写入fail closed。迁移同时把failed-after-succeeded冲突从generic binding升级为完整success chain验证，但不实现KMS本身。

`users` 是业务主体真源。`tasks` 与 `uploads` 保存创作流水线状态。`capabilities` 保存能力索引、定义对象键和当前 UI 指针。`sessions`、`turns`、`messages` 与 `artifacts` 保存试用和 Studio 状态；大内容仍在 MinIO。认证表只保存规范身份以及验证码、目标和 Cookie 的摘要，不保存验证码、Cookie 或供应商令牌原文。计费表把用户全局钱包与每个 Agent 的免费额度分开，使用记录绑定唯一 Turn，充值订单把外部支付状态与内部入账状态分开，资金流水只允许追加。VNext 表把 Snapshot 密文对象索引、AgentVersion、邀请授权、在线 Deployment、短租约、Consumer 多轮消息和执行 Journal 分开；Conversation 在创建事务中固定 serving Version 与 Worker，`(consumer_subject_id, idempotency_key)` 防止重复创建。消息只保存 AEAD 密文与 HMAC 摘要，Event payload 明确拒绝 Prompt、答案、Token、路径和 Reasoning。成功终态同时写入独立 Consumer Event Outbox 与 stream cursor，Redis/SSE 只能在 PostgreSQL commit 后投影；七天回放保留期由 Reconciler 原子推进过期 cursor。

## 认证与权限

`0007` 在改变 `users` 前取得排他锁，并在发现任何用户时以 SQLSTATE `55000` 整体失败。它把账号限制为 `creator-` 加八位小写 Base32，把角色限制为唯一的 `creator`，将会话期限固定为七天，并允许显式撤销。该迁移不读取、转换或恢复旧身份。

`combo_api` 可以读写认证表、任务、上传、能力和模型审计，并获得充值订单、支付尝试、回调、钱包可用余额与充值流水所需的最小表级和列级权限。`combo_worker` 只能处理任务、上传、能力和模型审计，不能读取认证或计费表。`combo_runtime` 只读 `users` 与 `auth_sessions`，读写 Session、Turn、Message 与 Artifact；它只获得 `capabilities.ui_artifact_id` 的列级更新权限，以及免费额度、钱包预留、使用记录和使用流水所需的计费权限。`combo_api` 与 `combo_runtime` 都只能查询和追加资金流水，不能修改、删除或清空既有流水；API 只能追加充值入账，Runtime 只能追加使用扣款。

VNext 不扩大以上旧角色权限。`combo_agent_api` 处理 Creator control-plane 与 Invocation admission，`combo_agent_consumer_api` 只读创建所需的最小列并只能调用原子 Conversation create capability，`combo_agent_broker` 处理 Worker 连接、Lease、命令投递与 exact ready projector，`combo_agent_reconciler` 只处理有界对账与终态恢复；这些角色均没有 `BYPASSRLS`，每个事务必须设置精确 `app.creator_id`，Consumer 数据事务还设置 `app.consumer_id`。复合租户外键阻止跨 Creator 拼接，RLS 防止漏写 owner filter。`combo_agent_maintenance` 保持 `NOLOGIN` 且默认没有表权限，只作为后续受审计的 break-glass 身份占位。

计费约束在事务提交时强制验证 `可用余额 + 预留余额 = 不可变流水净额`、钱包预留与运行中使用记录一致、免费计数与免费使用记录一致，并双向核对成功充值/完成扣费与其唯一流水。应用不能只改余额或终态，也不能只伪造一条外观合法的流水。乐收赢付款时间属于外部秒级时钟，不与数据库订单创建时间硬比较；内部 `credited_at` 仍使用数据库时间。

迁移容器使用数据库所有者连接。`0008`、`0012` 与 `0014` 先用 `NOLOGIN` 建立并收紧角色；全部迁移和账本复验成功后，Runner 才通过绑定参数设置独立密码并启用对应角色组。旧三角色、VNext control-plane 三角色与 Consumer 单角色可以分开 expand rollout；密码不进入 SQL 文件、迁移账本、命令参数或日志。当前部署仍没有 Consumer secret，公网 flag 继续固定关闭。

## Runner 与验证

Runner 要求迁移文件从 `0000` 连续编号，并要求 `schema_migrations` 恰好是源文件序列的前缀。未知文件、重复记录、跳号、旧迁移链、非空 schema 配空 ledger 或发布清单声明的迁移头不一致都会在执行新 SQL 前失败。Runner 使用 PostgreSQL advisory lock；每个迁移和对应记账位于同一事务。

```sh
pnpm -F @cb/db migrate
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0028_creator_agent_success_fact_admission.sql pnpm -F @cb/db migrate
pnpm -F @cb/db migrate:status
node --experimental-strip-types db/scripts/migrate.ts --head
pnpm -F @cb/db test
```

`MIGRATION_RUNS=2` 会在同一连接与 advisory lock 内重新读取并严格验证完整账本。真实 PostgreSQL 集成还必须证明空库执行、第二次幂等、`0007` 非空用户门禁、计费约束和三个应用角色的正负权限。
