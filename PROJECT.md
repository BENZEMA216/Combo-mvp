# Combo 产品基线

> 本文件只定义 Combo 当前已经确认的三部分：唯一产品目标、目标用户体验和唯一产物模型。
>
> `G-001@v1` · **可分享 Agent** 是本项目当前唯一产品目标。目标句一经确认不得改写；目标发生变化时只能新增版本。

本文出现的标识均使用“稳定 ID · 语义名称”双命名。

## 一、唯一产品目标

### `G-001@v1` · 可分享 Agent

> **让用户把一段和自己AGENT的对话、项目或旅程变成一个可分享的 Agent，让其他人打开链接就能使用它，或是用一段话就能让自己的AGENT获取对应能力。**

- 状态：`ACTIVE` · 当前生效
- 目标文本 SHA-256：`d1fcc3355deca962632194c4fbfcd26c4ce5f4494f1af0f813c7ff0a4d7be9ee`
- 变更规则：不得修改本目标文本；在人工确认体验完成前，不得新增产品目标。

Combo 的唯一交付物是不可变、可验证、可分享和可加载的 **Agent Package**。页面、服务、数据库记录和运行会话都服务于这个交付物，不得形成另一套并列的产品真相。

## 二、目标用户体验

### 创作者

```text
创作者在当前 Codex 任务中完成了一项工作
                │
                ▼
      用一句自然语言告诉自己的 Codex，把刚才的工作做成 Agent
                │
                ▼
            Agent Studio
    自动读取来源、提取方法并编译 Agent Package
    展示 Agent 的身份、能力、来源和真实试跑结果
                │
                ▼
          创作者点击“发布”
                │
                ▼
            获得分享链接
```

创建动作由一句自然语言直接发起，不要求用户理解文件路径、Manifest、Digest、Draft 或冻结命令。Agent Studio 是创作者查看、修订和试跑 Agent 的产品界面，可在codex中被使用。

当前对话是默认创作来源：用户在 Codex Desktop 当前任务发出上述指令时，只同意使用该任务中用户可见的对话，
不授权读取 Project。系统必须绑定用户正在操作的当前任务，不接受业务调用方、Plugin 或 MCP 通过 task、thread、
session 标识或 raw transcript 选择其他来源。普通用户不需要打开 Terminal、配置或信任 Hook、填写 Project 路径，
也不需要复制内部协议。Project 或工作旅程只能由用户另行明确选择，不能作为当前对话失败后的自动回退。

### 使用者

```text
使用者打开分享链接
        │
        ▼
查看 Agent 的用途、能力和发布者
        │
        ▼
点击“在 Codex 中使用”
        │
        ▼
Agent 自动加载到当前 Codex Project（用户可以有简要的手动复制操作）
        │
        ▼
在同一个 Codex 对话中持续完成工作
```

使用者不需要再次选择已经处于焦点状态的 Project。分享页负责理解和启动，真正的 Agent 推理由 Codex 与已加载的 Agent Package 在使用者自己的 Project 中完成。

## 三、唯一产物模型

```text
已完成的工作
    │
    ▼
Agent Package Draft
    │ 编译
    ▼
Agent Package
    │ 发布引用
    ▼
Agent Package Release
    │ 下载、校验和安装
    ▼
Installed Agent
    │ 绑定当前 Project 和 Codex 任务
    ▼
Agent Session
```

- **Agent Package Draft**：创建期间可以查看和修订的中间状态，不直接分享或运行。
- **Agent Package**：唯一可交付、可验证和可运行的不可变产物。它至少包含 `agent.json`、`AGENT.md` 和 `skills/`，所有文件都由 Package digest 绑定。
- **Agent Package Release**：服务器对一个 exact Package digest 的发布记录，不复制或改写另一份 Agent 定义。
- **Installed Agent**：使用者本地经过完整性校验的 Package 副本。
- **Agent Session**：exact Package、使用者当前 Project 和一个 Codex 对话线程的运行绑定。

公开页面、搜索索引、发布卡片和数据库读模型都从 Agent Package 投影产生，不能另外维护一份可能漂移的 Prompt 或 Agent 定义。

---

尚未由用户确认的工程拆解保存在 [ENGINEERING.md](./ENGINEERING.md)，并在开发体验中持续验证和调整。
