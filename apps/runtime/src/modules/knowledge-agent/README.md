# modules/knowledge-agent 受控 Test 知识 Agent

本目录把 Capability v2 投影解析为 exact Agent Package Release，并在 Combo Test 的显式候选白名单内执行固定知识问答。Preview 和 Production 不能开启这个门禁。Test gate v1 保留精确问答 oracle；v2 接受没有预置问题的陌生提问，并使用固定的保守整句抽取规则验证候选答案。

## 唯一产品真源

- `resolver.ts` 先核对 Runtime source SHA、发布者、Capability、Release 和 Package 白名单，再用 Registry 中的 exact `(releaseId, packageDigest)` 解析 Package；同一文件还提供单次候选提交、v1 精确 oracle 和 v2 平台验证。
- `grounding.ts` 为中文内容提供汉字二元组、三元组和完整拉丁字母或数字 token 的确定性检索，并让长文本 excerpt 围绕实际命中。检索索引可用 NFKC 做召回；v2 计费验证单独使用 NFC，要求每个答案句保持原句的内部空白、句末标点和有序完整 token，并与某个引用 excerpt 的完整陈述句逐字相等。可结算句还必须有陈述式终止标点、主题之外的明确谓语或实质事实增量，不接受 Markdown 标题/列表、名词型片段、问题复述，或把短动作嵌入另一个词。名词型后缀只用于答案残句判断，不从问题主题删除。问题主题按分句结构解析：最长的分句尾完整疑问壳优先；没有尾壳时，至多移除一个句首或两侧都有充分内容的疑问操作词；`吗`、`呢` 只作为末尾问句粒子，`该服务的` 只作为整体指示脚手架。解析不会全局替换疑问字或关系字，因此 `什么值得买`、`如何阅读一本书`、`谁是凶手`、`去哪儿` 和 `等于号` 这类实体或标题保持完整。剩余实体、规则、方式、流程、功能、政策、说明与指南等名词属性，以及动作、关系、否定、条件和时间表达都必须与冻结来源直接对齐；当前中文 Beta 不做前提纠正或关系等价推理。主题提取忽略用户空白，但不跨标点或遮蔽边界拼接；每个至少二字的剩余汉字段都必须作为完整连续子串出现在整段答案中，每个短动作或状态组都单独保留谓语上下文，每个答案句也必须完整命中至少一组。问题同时含汉字组和拉丁字母或数字 token 时，每个答案句还必须覆盖全部 token，不能用其他句子补齐年份、版本或协议限定。没有汉字组时，整段答案及每个答案句都必须覆盖全部 token，并覆盖一个至少包含两个字符且含拉丁字母并且不是 API/HTTP/HTTPS 的完整 token，或覆盖一个至少三位且不是四位年份的纯数字 token。每个答案句还必须在未拼接的剩余片段中给出问题外的新汉字二/三元组、新数值或 OAuth 这类新的辨识性拉丁 token；`本身`、`自身`、中文/英文谓语、英文功能词、Combo、API/HTTP、单个年份和问题内子串复述不能单独构成信息增量。FAQ 问句/标题、自指复述、实体/名词属性/动作/关系/时间替换、限定漂移、单字母、短数字、单个年份或 API token、跨句借 token 都不能触发结算。缺少直接对齐的主题、关系或限定时应提交 insufficient 且不收费，若仍按 answered 提交则由平台拒绝且不结算。通过只表示固定 Package 文本提供了直接支持并与问题有确定性文本关联，不证明来源本身的事实真值。
- 对象 key 只由 Package digest 和 manifest path 推导。知识必须是 Package inventory 中的 `skills/knowledge/references/knowledge-bundle.json`，不接受 latest、自由 storage key 或独立 Bundle selector。
- manifest、AGENT.md、SKILL.md 和 Bundle 都在有界读取后核对 byte length 与 digest；UTF-8 错误、Registry 漂移、owner/scope 错配一律失败关闭。
- Session 创建时一次冻结 Release、Package 和知识资源绑定。后续 Turn 只信 Session 真值，请求中的解析结果只做 exact assertion。

## 回答和结算

- `resolver.ts` 提供确定性 `knowledge_search` 和单次 `submit_knowledge_answer`。v1 使用平台拥有的 controlled-Test oracle 验证问题、答案和引用；v2 使用不可配置的固定整句抽取策略验证陌生问题候选。引用只能指向本 Turn 已暴露的 chunk，且必须去重、升序；Package、模型和环境配置都不能调节“已回答”规则。
- 模型文本和 transcript 都是候选材料，不写 Message、Redis 或 SSE。只有平台验证后的最终 Message 可见。
- `resolver.ts` 还按 Session → Turn → charge → response Message 的锁序，在一个事务内写终态、结算或释放、权威 Message 和不可变 receipt。`answered` 才扣费；`insufficient_evidence`、`failed` 和 `interrupted` 都释放预留。
- 详情投影会重算 response digest，并从冻结 Bundle 解析 citation label。Message 或 citation 不一致时不返回伪造结果。

跨副本中断、进程关闭和超时清扫都复用同一知识终态事务。通用 legacy reconciler 不会从 completed Turn 推测知识收费结果。
