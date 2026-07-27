# sandbox-exec 命令写入边界

这个目录构建独立的 `sandbox-exec` 可执行文件。Linux 实现要求 Landlock ABI 3，给 `/workspace`、`/tmp` 和 `/dev/null` 添加写权限后执行非交互 Bash；其他路径保持只读。内核不支持要求的能力、规则创建失败或参数无效时，程序以 126 退出，不启动 Bash。

`main_unsupported.go` 让非 Linux 构建明确失败。`main_test.go` 在 Linux 子进程中验证工作区写入成功、白名单外文件不变，并确认 `/dev/null` 仍可使用。
