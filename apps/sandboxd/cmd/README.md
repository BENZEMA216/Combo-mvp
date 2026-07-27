# sandboxd 辅助命令

这个目录保存 sandboxd 镜像内的独立辅助进程。当前只有 `sandbox-exec/`，它在启动不可信 Bash 前建立内核写入白名单。主守护进程通过固定绝对路径调用该程序，不直接执行生产 Bash。
