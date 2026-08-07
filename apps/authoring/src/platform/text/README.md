# platform/text — 会话文本工具

这个目录放识别「编码代理运行时自动生成的噪声文本」的纯函数，供会话解析和能力提取共用，避免环境说明、标题生成指令这类平台注入内容被当成用户的真实工作内容。

## 文件

- `session-noise.ts` 导出四个函数：firstNonEmptyLine 取文本第一个非空行；stripRolePrefix 去掉行首的 user:/assistant: 等角色前缀；isPlatformPromptText 按前缀清单和完整包裹块清单判断一段文本是不是平台注入的提示词，其中 recommended_plugins / environment_context 只有在一个或多个已知宿主块完整占满整条消息时才过滤；isBlockedCapabilityLabel 判断一个标题能不能用作能力项名字（空或属于平台噪声就拒绝）。

## 上下游

被谁使用：`modules/task/session-parse.ts` 在解析 Codex 会话时用 isPlatformPromptText 剥掉运行时注入的伪用户消息；`modules/task/extract.ts` 在解析模型输出时用 isBlockedCapabilityLabel 过滤能力名字。

依赖什么：纯函数，零 import，不访问任何外部资源。
