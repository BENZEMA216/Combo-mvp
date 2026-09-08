# 项目内 Agent Package 接收器

- `contract.ts` 定义受控 Test origin、Node 和平台边界、严格命令参数、安全错误及轻量三文本文件范围；
  原包清单与摘要直接复用协议包，不复制另一套 Package 规范。
- `download.ts` 执行两个有时限和字节上限的匿名 GET，拒绝重定向或关闭 TLS，并核对公开投影与裸 Package。
- `filesystem.ts` 对 Host 提供的 canonical 项目根和逐段目录绑定 inode，提供拒绝符号链接、排他写入、
  有界普通文件读取与精确目录清单检查；不扫描使用者业务内容，也不声称具备操作系统级隔离。
- `adapter.ts` 生成原包之外的固定显式调用入口、策略、同一可信接收器副本和安装收据，不插入发布者提供的
  frontmatter，不改变原 Package，也不把文本文件范围解释成工具能力已经全部满足。
- `install.ts` 完成目标前置检查、排他锁、原包与适配器逐字节读回、最后发布入口、失败时只清理已核对身份的
  自有文件，以及完整重复安装的精确幂等；不覆盖异物，不递归删除不完整目录。
- `cli.ts` 提供无导入副作用的公开子路径与单次命令入口，读取自身的有界可信工件副本，调用安装或离线验证，
  输出安全结果并固定推理状态为尚未运行。

此目录属于接收器应用边界，只依赖 Node 内置模块、包内文件及纯 Package 协议与 Schema。
它不导入 Creator 来源扫描、Host、Session、Worker、Broker、数据库或旧版 AgentVersion，不读取凭据或其他任务，
不执行 Package 文件，也不写全局目录、项目 `AGENTS.md` 或任何已存在文件。
原包在 `.combo/agent-packages/sha256/` 下保持逐字节不变，薄适配器在项目 `.agents/skills/` 下可被发现。
当前仅支持已有 Node 24.2 及以上的 macOS 和 Linux；不提供 Windows 或运行时安装回退。

只有入口激活是原子的，不承诺多目录写入形成一个全局事务。目录身份和 no-follow 检查覆盖稳定链接与常见
置换，不证明同 UID 对手精确竞态下的操作系统隔离。安装目录属于 Host 显式选定路径，不是 active-task 证明。
安装收据与成功退出不证明 Agent 已在 Codex 实际生效；同一对话实际应用和跨用户两轮验收须独立记录。
