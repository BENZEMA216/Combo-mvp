# modules/knowledge-agent 受控 Test 知识 Agent

本目录把 Capability v2 投影解析为 exact Agent Package Release，并在 Combo Test 的显式候选白名单内执行固定知识问答。Preview 和 Production 不能开启这个门禁。Test gate v1 保留精确问答 oracle；v2 接受没有预置问题的陌生提问，并使用固定的保守整句抽取规则验证候选答案。

## 唯一产品真源

- `resolver.ts` 先核对 Runtime source SHA、发布者、Capability、Release 和 Package 白名单，再用 Registry 中的 exact `(releaseId, packageDigest)` 解析 Package；同一文件还提供单次候选提交、v1 精确 oracle 和 v2 平台验证。
- `grounding.ts` 为中文内容提供汉字二元组、三元组和完整拉丁字母或数字 token 的确定性检索，并让长文本 excerpt 围绕实际命中。它还要求 v2 候选的每个事实性句子都逐字复用某个引用 excerpt 中的完整原句，并要求每条引用直接支持至少一个句子；通过只表示固定 Package 文本提供了直接支持，不证明来源本身的事实真值。
- 对象 key 只由 Package digest 和 manifest path 推导。知识必须是 Package inventory 中的 `skills/knowledge/references/knowledge-bundle.json`，不接受 latest、自由 storage key 或独立 Bundle selector。
- manifest、AGENT.md、SKILL.md 和 Bundle 都在有界读取后核对 byte length 与 digest；UTF-8 错误、Registry 漂移、owner/scope 错配一律失败关闭。
- Session 创建时一次冻结 Release、Package 和知识资源绑定。后续 Turn 只信 Session 真值，请求中的解析结果只做 exact assertion。

## 回答和结算

- `resolver.ts` 提供确定性 `knowledge_search` 和单次 `submit_knowledge_answer`。v1 使用平台拥有的 controlled-Test oracle 验证问题、答案和引用；v2 使用不可配置的固定整句抽取策略验证陌生问题候选。引用只能指向本 Turn 已暴露的 chunk，且必须去重、升序；Package、模型和环境配置都不能调节“已回答”规则。
- 模型文本和 transcript 都是候选材料，不写 Message、Redis 或 SSE。只有平台验证后的最终 Message 可见。
- `resolver.ts` 还按 Session → Turn → charge → response Message 的锁序，在一个事务内写终态、结算或释放、权威 Message 和不可变 receipt。`answered` 才扣费；`insufficient_evidence`、`failed` 和 `interrupted` 都释放预留。
- 详情投影会重算 response digest，并从冻结 Bundle 解析 citation label。Message 或 citation 不一致时不返回伪造结果。

跨副本中断、进程关闭和超时清扫都复用同一知识终态事务。通用 legacy reconciler 不会从 completed Turn 推测知识收费结果。
