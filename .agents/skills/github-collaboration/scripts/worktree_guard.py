#!/usr/bin/env python3
"""只读规划并检查 GitHub 贡献工作树。"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlsplit, urlunsplit


ALLOWED_TYPES = (
    "feat",
    "fix",
    "refactor",
    "perf",
    "test",
    "docs",
    "ci",
    "build",
    "chore",
)
SLUG_PATTERN = re.compile(r"(?:[0-9]+-)?[a-z0-9]+(?:-[a-z0-9]+)*\Z")
PR_EVIDENCE_PATTERN = re.compile(
    r"(?:[0-9]+|https://github\.com/[^/]+/[^/]+/pull/[0-9]+)\Z"
)
GIB = 1024**3
DEFAULT_GIT_TIMEOUT_SECONDS = 20
GIT_FSCK_TIMEOUT_SECONDS = 120
TEXT_LABELS = {
    "operation": "操作",
    "mutates_repository": "是否修改仓库",
    "primary_worktree": "主工作树",
    "worktree": "工作树",
    "branch": "分支",
    "head": "当前提交",
    "base": "基线",
    "base_oid": "已获取的基线提交",
    "base_remote": "基准远端",
    "push_remote": "推送远端",
    "ahead_base": "领先基线的提交数",
    "behind_base": "落后基线的提交数",
    "upstream": "上游跟踪分支",
    "ahead_upstream": "未推送提交数",
    "behind_upstream": "落后上游的提交数",
    "status_lines": "工作树状态",
    "dirty": "工作树是否有改动",
    "conflict_files": "冲突文件",
    "worktree_path": "工作树路径",
    "untracked_control_files": "控制面未跟踪文件",
    "commands": "建议命令",
    "ready": "是否就绪",
    "blocking_reasons": "阻塞原因",
    "merged_pr_evidence": "已合并拉取请求证据",
    "merge_method": "合并方式",
    "external_verification_required": "外部验证要求",
    "remote_branch_action": "远端分支操作",
    "repository": "GitHub 仓库",
    "free_disk_gib": "可用磁盘 GiB",
    "minimum_free_disk_gib": "最低磁盘 GiB",
    "recommended_free_disk_gib": "建议磁盘 GiB",
    "git_integrity": "Git 对象库",
    "cloud_managed_path": "云盘托管路径",
    "warnings": "警告",
    "error": "错误",
}
TEXT_VALUES = {
    "plan-create": "规划创建",
    "inspect": "检查状态",
    "check-pr-ready": "检查拉取请求就绪状态",
    "plan-cleanup": "规划清理",
    "check-dev-ready": "检查开发环境就绪状态",
    "merge": "合并提交",
    "squash": "压缩合并",
    "rebase": "变基合并",
    "none": "无",
}


class GuardError(RuntimeError):
    """确定性的流程前置条件未满足。"""


def git_timeout_seconds() -> int:
    raw = os.environ.get("COMBO_GIT_TIMEOUT_SECONDS", str(DEFAULT_GIT_TIMEOUT_SECONDS))
    try:
        timeout = int(raw)
    except ValueError as error:
        raise GuardError("COMBO_GIT_TIMEOUT_SECONDS 必须是正整数秒数") from error
    if timeout <= 0:
        raise GuardError("COMBO_GIT_TIMEOUT_SECONDS 必须是正整数秒数")
    return timeout


class ChineseArgumentParser(argparse.ArgumentParser):
    """提供中文帮助和常见参数错误。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["add_help"] = False
        super().__init__(*args, **kwargs)
        self._positionals.title = "位置参数"
        self._optionals.title = "选项"
        self.add_argument("-h", "--help", action="help", help="显示帮助并退出")

    def format_usage(self) -> str:
        return super().format_usage().replace("usage:", "用法：", 1)

    def format_help(self) -> str:
        return super().format_help().replace("usage:", "用法：", 1)

    def error(self, message: str) -> None:
        translations = (
            ("the following arguments are required:", "缺少必需参数："),
            ("unrecognized arguments:", "无法识别的参数："),
            ("invalid choice:", "无效选择："),
            ("argument ", "参数 "),
        )
        for source, target in translations:
            message = message.replace(source, target)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: 参数错误：{message}\n")


def run_command(
    command: Sequence[str],
    cwd: Path | None = None,
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    effective_timeout = timeout if timeout is not None else git_timeout_seconds()
    try:
        result = subprocess.run(
            list(command),
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=effective_timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise GuardError(
            f"{shlex.join(command)}: 超过 {effective_timeout} 秒仍未完成；"
            "请检查云盘托管、磁盘余量或 Git 对象库损坏"
        ) from error
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "命令执行失败"
        raise GuardError(f"{shlex.join(command)}: {detail}")
    return result


def git(
    repo: Path,
    *args: str,
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    return run_command(("git", "-C", str(repo), *args), check=check, timeout=timeout)


def repository_root(path: str | Path) -> Path:
    candidate = Path(path).expanduser().resolve()
    result = git(candidate, "rev-parse", "--show-toplevel")
    return Path(result.stdout.strip()).resolve()


def parse_worktrees(repo: Path) -> list[dict[str, str]]:
    output = git(repo, "worktree", "list", "--porcelain").stdout
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in output.splitlines():
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    if current:
        records.append(current)
    return records


def primary_worktree(repo: Path) -> Path:
    records = parse_worktrees(repo)
    if not records:
        raise GuardError("Git 未报告主工作树")
    return Path(records[0]["worktree"]).resolve()


def remote_names(repo: Path) -> list[str]:
    return [name for name in git(repo, "remote").stdout.splitlines() if name]


def require_remote(repo: Path, remote: str) -> str:
    if remote not in remote_names(repo):
        raise GuardError(f"Git 远端不存在：{remote}")
    return remote


def select_base_remote(repo: Path, requested: str | None) -> str:
    if requested:
        return require_remote(repo, requested)
    names = remote_names(repo)
    if "upstream" in names:
        return "upstream"
    if "origin" in names:
        return "origin"
    raise GuardError("无法选择基准远端；请传入 --base-remote")


def select_push_remote(
    repo: Path, requested: str | None, base_remote: str
) -> str:
    if requested:
        return require_remote(repo, requested)
    names = remote_names(repo)
    return "origin" if "origin" in names else base_remote


def remote_default(repo: Path, remote: str) -> str | None:
    result = git(
        repo,
        "symbolic-ref",
        "--quiet",
        "--short",
        f"refs/remotes/{remote}/HEAD",
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    for candidate in (f"{remote}/main", f"{remote}/master"):
        resolved = git(
            repo,
            "rev-parse",
            "--verify",
            f"{candidate}^{{commit}}",
            check=False,
        )
        if resolved.returncode == 0:
            return candidate
    return None


def resolve_base(repo: Path, requested: str | None, base_remote: str) -> str:
    candidates: list[str] = []
    if requested:
        short_prefix = f"{base_remote}/"
        full_prefix = f"refs/remotes/{base_remote}/"
        if "/" in requested and not requested.startswith(
            (short_prefix, full_prefix)
        ):
            raise GuardError(
                f"基线引用 {requested} 不属于基准远端 {base_remote}"
            )
        candidates.append(requested)
        if "/" not in requested:
            candidates.insert(0, f"{base_remote}/{requested}")
    else:
        detected = remote_default(repo, base_remote)
        if detected:
            candidates.append(detected)
    for candidate in candidates:
        result = git(
            repo,
            "rev-parse",
            "--verify",
            f"{candidate}^{{commit}}",
            check=False,
        )
        if result.returncode == 0:
            return candidate
    if requested:
        raise GuardError(f"基线引用无法解析为提交：{requested}")
    raise GuardError(
        f"无法解析 {base_remote} 的默认分支；"
        "请在获取基准远端后传入 --base"
    )


def validate_slug(slug: str) -> None:
    if not SLUG_PATTERN.fullmatch(slug):
        raise GuardError(
            "任务短名必须使用小写短横线形式，可以在开头添加 Issue 编号"
        )


def relative_to(path: Path, parent: Path) -> bool:
    try:
        return os.path.commonpath((str(path), str(parent))) == str(parent)
    except ValueError:
        return False


def github_repository(remote_url: str) -> str | None:
    """从常见 GitHub remote 语法中提取 owner/repo，不返回 userinfo。"""
    raw = remote_url.strip()
    path: str | None = None
    if raw.startswith("git@github.com:"):
        path = raw.removeprefix("git@github.com:")
    else:
        parsed = urlsplit(raw)
        if parsed.hostname and parsed.hostname.lower() == "github.com":
            path = parsed.path.lstrip("/")
    if path is None:
        return None
    path = path.removesuffix(".git")
    parts = path.split("/")
    if len(parts) != 2 or not all(parts):
        return None
    return "/".join(parts)


def sanitized_remote_url(remote_url: str) -> str:
    """输出远端地址前移除 URL userinfo，避免 token 进入终端或 CI 日志。"""
    raw = remote_url.strip()
    parsed = urlsplit(raw)
    if parsed.scheme and parsed.hostname:
        host = parsed.hostname
        try:
            port = parsed.port
        except ValueError:
            port = None
        if port is not None:
            host = f"{host}:{port}"
        return urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))
    if raw.startswith("git@github.com:"):
        return raw
    return "<无法识别的远端地址>"


def cloud_managed_path(path: Path, platform: str | None = None) -> bool:
    if (platform or sys.platform) != "darwin":
        return False
    home = Path.home().resolve()
    candidates = (
        home / "Documents",
        home / "Desktop",
        home / "Library" / "CloudStorage",
        home / "Library" / "Mobile Documents",
    )
    return any(relative_to(path, candidate.resolve()) for candidate in candidates)


def disk_space_gib(path: Path) -> float:
    return shutil.disk_usage(path).free / GIB


def rev_counts(repo: Path, left: str, right: str) -> tuple[int, int]:
    result = git(repo, "rev-list", "--left-right", "--count", f"{left}...{right}")
    left_only, right_only = result.stdout.strip().split()
    return int(left_only), int(right_only)


def current_branch(repo: Path) -> str | None:
    result = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def upstream_branch(repo: Path) -> str | None:
    result = git(
        repo,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def inspect_state(
    path: str | Path,
    requested_base: str | None,
    requested_base_remote: str | None,
    requested_push_remote: str | None,
) -> dict[str, Any]:
    root = repository_root(path)
    base_remote = select_base_remote(root, requested_base_remote)
    push_remote = select_push_remote(root, requested_push_remote, base_remote)
    base = resolve_base(root, requested_base, base_remote)
    base_oid = git(root, "rev-parse", f"{base}^{{commit}}").stdout.strip()
    branch = current_branch(root)
    head = git(root, "rev-parse", "HEAD").stdout.strip()
    status_lines = [
        line
        for line in git(
            root, "status", "--porcelain=v1", "--untracked-files=all"
        ).stdout.splitlines()
        if line
    ]
    conflict_files = [
        line
        for line in git(root, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        if line
    ]
    behind_base, ahead_base = rev_counts(root, base, "HEAD")
    upstream = upstream_branch(root)
    behind_upstream: int | None = None
    ahead_upstream: int | None = None
    if upstream:
        behind_upstream, ahead_upstream = rev_counts(root, upstream, "HEAD")
    return {
        "worktree": str(root),
        "primary_worktree": str(primary_worktree(root)),
        "branch": branch,
        "head": head,
        "base": base,
        "base_oid": base_oid,
        "base_remote": base_remote,
        "push_remote": push_remote,
        "ahead_base": ahead_base,
        "behind_base": behind_base,
        "upstream": upstream,
        "ahead_upstream": ahead_upstream,
        "behind_upstream": behind_upstream,
        "status_lines": status_lines,
        "dirty": bool(status_lines),
        "conflict_files": conflict_files,
    }


def plan_create(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    root = repository_root(args.repo)
    primary = primary_worktree(root)
    if root != primary:
        raise GuardError(
            f"plan-create 必须针对主控制检出目录运行：{primary}"
        )
    tracked_changes = git(
        root, "status", "--porcelain=v1", "--untracked-files=no"
    ).stdout.splitlines()
    if tracked_changes:
        raise GuardError("主控制检出目录存在受跟踪改动")
    untracked = git(root, "ls-files", "--others", "--exclude-standard").stdout.splitlines()
    validate_slug(args.slug)
    base_remote = select_base_remote(root, args.base_remote)
    push_remote = select_push_remote(root, args.push_remote, base_remote)
    base = resolve_base(root, args.base, base_remote)
    base_oid = git(root, "rev-parse", f"{base}^{{commit}}").stdout.strip()
    branch = f"{args.type}/{args.slug}"
    if git(
        root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False
    ).returncode == 0:
        raise GuardError(f"本地分支已经存在：{branch}")
    registered = parse_worktrees(root)
    if any(record.get("branch") == f"refs/heads/{branch}" for record in registered):
        raise GuardError(f"分支已经登记到某个工作树：{branch}")
    if git(
        root,
        "show-ref",
        "--verify",
        "--quiet",
        f"refs/remotes/{push_remote}/{branch}",
        check=False,
    ).returncode == 0:
        raise GuardError(
            f"推送远端已经存在同名分支：{push_remote}/{branch}"
        )
    default_name = f"{primary.name}-wt-{args.type}-{args.slug}"
    target = (
        Path(args.path).expanduser().resolve()
        if args.path
        else primary.parent.joinpath(default_name).resolve()
    )
    if target.exists() or any(
        Path(record["worktree"]).resolve() == target for record in registered
    ):
        raise GuardError(f"工作树路径已经存在或已经登记：{target}")
    if relative_to(target, primary):
        raise GuardError("工作树路径必须位于主检出目录之外")
    commands = [
        shlex.join(
            ("git", "-C", str(primary), "fetch", "--prune", base_remote)
        )
    ]
    if push_remote != base_remote:
        commands.append(
            shlex.join(
                ("git", "-C", str(primary), "fetch", "--prune", push_remote)
            )
        )
    commands.append(
        shlex.join(
            (
                "git",
                "-C",
                str(primary),
                "worktree",
                "add",
                "-b",
                branch,
                str(target),
                base_oid,
            )
        )
    )
    return (
        {
            "operation": "plan-create",
            "mutates_repository": False,
            "primary_worktree": str(primary),
            "base": base,
            "base_oid": base_oid,
            "base_remote": base_remote,
            "push_remote": push_remote,
            "branch": branch,
            "worktree_path": str(target),
            "untracked_control_files": untracked,
            "commands": commands,
        },
        0,
    )


def inspect(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    data = inspect_state(
        args.worktree, args.base, args.base_remote, args.push_remote
    )
    data["operation"] = "inspect"
    data["mutates_repository"] = False
    return data, 0


def check_pr_ready(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    data = inspect_state(
        args.worktree, args.base, args.base_remote, args.push_remote
    )
    base_branch = data["base"].rsplit("/", 1)[-1]
    reasons: list[str] = []
    if data["branch"] is None:
        reasons.append("HEAD 处于分离状态")
    elif data["branch"] == base_branch:
        reasons.append("当前检出的是默认分支或基线分支")
    if data["status_lines"]:
        reasons.append("工作树存在已修改、已暂存或未跟踪文件")
    if data["conflict_files"]:
        reasons.append("工作树存在未解决冲突")
    if data["ahead_base"] == 0:
        reasons.append("分支没有领先于基线的提交")
    if data["behind_base"] != 0:
        reasons.append("分支落后于已经获取的基线")
    if data["upstream"] is None:
        reasons.append("分支没有上游跟踪分支")
    else:
        expected_upstream = f"{data['push_remote']}/{data['branch']}"
        if data["upstream"] != expected_upstream:
            reasons.append(
                f"分支上游是 {data['upstream']}，预期为 {expected_upstream}"
            )
        if data["ahead_upstream"] != 0:
            reasons.append("分支存在未推送提交")
    data.update(
        {
            "operation": "check-pr-ready",
            "mutates_repository": False,
            "ready": not reasons,
            "blocking_reasons": reasons,
        }
    )
    return data, 0 if not reasons else 1


def check_dev_ready(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    data = inspect_state(
        args.worktree, args.base, args.base_remote, args.push_remote
    )
    root = Path(data["worktree"]).resolve()
    primary = Path(data["primary_worktree"]).resolve()
    reasons: list[str] = []
    warnings: list[str] = []

    resolved_base = git(
        root, "rev-parse", "--symbolic-full-name", data["base"], check=False
    ).stdout.strip()
    if not resolved_base.startswith(f"refs/remotes/{data['base_remote']}/"):
        reasons.append("开发基线必须是规范基准远端的分支，不能使用裸 SHA 或本地引用")

    remote_url = git(root, "remote", "get-url", data["base_remote"]).stdout.strip()
    repository = github_repository(remote_url)
    if repository is None or repository.lower() != args.expected_repository.lower():
        reasons.append(
            f"基准远端指向 {sanitized_remote_url(remote_url)}，"
            f"预期 GitHub 仓库为 {args.expected_repository}"
        )
    if root == primary:
        reasons.append("当前目录是主控制检出；开发必须在独立任务工作树中进行")

    is_cloud_managed = cloud_managed_path(root)
    if is_cloud_managed and not args.allow_cloud_worktree:
        reasons.append(
            "工作树位于 macOS 云盘托管目录；请迁移到 ~/Developer 等本地目录"
        )

    free_gib = disk_space_gib(root)
    if free_gib < args.minimum_free_gib:
        reasons.append(
            f"可用磁盘仅 {free_gib:.1f} GiB，低于最低要求 {args.minimum_free_gib:.1f} GiB"
        )
    elif free_gib < args.recommended_free_gib:
        warnings.append(
            f"可用磁盘为 {free_gib:.1f} GiB，建议在完整测试前提升到 "
            f"{args.recommended_free_gib:.1f} GiB"
        )

    base_branch = data["base"].rsplit("/", 1)[-1]
    if data["branch"] is None:
        reasons.append("HEAD 处于分离状态")
    elif data["branch"] == base_branch:
        reasons.append("当前检出的是默认分支或基线分支")
    if data["status_lines"]:
        reasons.append("工作树存在已修改、已暂存或未跟踪文件")
    if data["conflict_files"]:
        reasons.append("工作树存在未解决冲突")
    if data["behind_base"] != 0:
        reasons.append("任务分支落后于已经获取的基线")

    integrity = git(
        root,
        "fsck",
        "--full",
        "--no-dangling",
        check=False,
        timeout=GIT_FSCK_TIMEOUT_SECONDS,
    )
    if integrity.returncode != 0:
        detail = integrity.stderr.strip() or integrity.stdout.strip() or "未知错误"
        reasons.append(f"Git 对象库完整性检查失败：{detail}")

    data.update(
        {
            "operation": "check-dev-ready",
            "mutates_repository": False,
            "repository": repository,
            "free_disk_gib": round(free_gib, 1),
            "minimum_free_disk_gib": args.minimum_free_gib,
            "recommended_free_disk_gib": args.recommended_free_gib,
            "git_integrity": "ok" if integrity.returncode == 0 else "failed",
            "cloud_managed_path": is_cloud_managed,
            "warnings": warnings,
            "ready": not reasons,
            "blocking_reasons": reasons,
        }
    )
    return data, 0 if not reasons else 1


def plan_cleanup(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if not PR_EVIDENCE_PATTERN.fullmatch(args.merged_pr):
        raise GuardError("--merged-pr 必须是拉取请求编号或规范 GitHub 拉取请求地址")
    data = inspect_state(
        args.worktree, args.base, args.base_remote, args.push_remote
    )
    target = Path(data["worktree"]).resolve()
    primary = Path(data["primary_worktree"]).resolve()
    branch = data["branch"]
    reasons: list[str] = []
    if target == primary:
        reasons.append("不能移除主工作树")
    if branch is None:
        reasons.append("清理要求当前关联一个本地任务分支")
    if data["status_lines"]:
        reasons.append("工作树存在已修改、已暂存或未跟踪文件")
    if data["conflict_files"]:
        reasons.append("工作树存在未解决冲突")
    if data["upstream"] and data["ahead_upstream"]:
        reasons.append("分支存在尚未进入上游跟踪分支的提交")
    if args.merge_method == "merge":
        ancestor = git(
            target,
            "merge-base",
            "--is-ancestor",
            data["head"],
            data["base"],
            check=False,
        )
        if ancestor.returncode != 0:
            reasons.append("分支顶端提交不是已经获取的基线的祖先")
    commands: list[str] = []
    if not reasons and branch:
        delete_flag = "-d" if args.merge_method == "merge" else "-D"
        commands = [
            shlex.join(
                ("git", "-C", str(primary), "worktree", "remove", str(target))
            ),
            shlex.join(("git", "-C", str(primary), "branch", delete_flag, branch)),
            shlex.join(
                (
                    "git",
                    "-C",
                    str(primary),
                    "worktree",
                    "prune",
                    "--dry-run",
                    "--verbose",
                )
            ),
        ]
    data.update(
        {
            "operation": "plan-cleanup",
            "mutates_repository": False,
            "ready": not reasons,
            "blocking_reasons": reasons,
            "merged_pr_evidence": args.merged_pr,
            "merge_method": args.merge_method,
            "commands": commands,
            "external_verification_required": (
                "请确认拉取请求状态为 MERGED，且结果已经进入所获取的基线；"
                "此离线防护工具不能查询 GitHub。"
            ),
            "remote_branch_action": "none",
        }
    )
    return data, 0 if not reasons else 1


def render_text(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, value in data.items():
        label = TEXT_LABELS.get(key, key)
        if isinstance(value, list):
            lines.append(f"{label}：")
            lines.extend(f"  - {item}" for item in value)
        elif value is None:
            lines.append(f"{label}：无")
        elif isinstance(value, bool):
            lines.append(f"{label}：{'是' if value else '否'}")
        else:
            lines.append(f"{label}：{TEXT_VALUES.get(str(value), value)}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = ChineseArgumentParser(
        description="在不修改 Git 的情况下规划并检查 GitHub 贡献工作树。"
    )
    subparsers = parser.add_subparsers(
        dest="command", required=True, title="子命令", metavar="命令"
    )

    create_parser = subparsers.add_parser(
        "plan-create", help="验证并输出工作树创建计划"
    )
    create_parser.add_argument("--repo", default=".")
    create_parser.add_argument("--base")
    create_parser.add_argument(
        "--base-remote", help="规范上游远端；默认依次尝试 upstream 和 origin"
    )
    create_parser.add_argument(
        "--push-remote", help="贡献者推送远端；默认为 origin"
    )
    create_parser.add_argument("--type", choices=ALLOWED_TYPES, required=True)
    create_parser.add_argument("--slug", required=True)
    create_parser.add_argument("--path")
    create_parser.add_argument("--format", choices=("text", "json"), default="text")
    create_parser.set_defaults(handler=plan_create)

    inspect_parser = subparsers.add_parser(
        "inspect", help="报告分支、基线、上游和工作树状态"
    )
    inspect_parser.add_argument("--worktree", default=".")
    inspect_parser.add_argument("--base")
    inspect_parser.add_argument("--base-remote")
    inspect_parser.add_argument("--push-remote")
    inspect_parser.add_argument("--format", choices=("text", "json"), default="text")
    inspect_parser.set_defaults(handler=inspect)

    ready_parser = subparsers.add_parser(
        "check-pr-ready", help="工作树未达到拉取请求评审条件时返回失败"
    )
    ready_parser.add_argument("--worktree", default=".")
    ready_parser.add_argument("--base")
    ready_parser.add_argument("--base-remote")
    ready_parser.add_argument("--push-remote")
    ready_parser.add_argument("--format", choices=("text", "json"), default="text")
    ready_parser.set_defaults(handler=check_pr_ready)

    dev_ready_parser = subparsers.add_parser(
        "check-dev-ready", help="验证任务工作树、远端、磁盘和 Git 对象库"
    )
    dev_ready_parser.add_argument("--worktree", default=".")
    dev_ready_parser.add_argument("--base")
    dev_ready_parser.add_argument("--base-remote")
    dev_ready_parser.add_argument("--push-remote")
    dev_ready_parser.add_argument(
        "--expected-repository", default="dangdang-tech/Combo"
    )
    dev_ready_parser.add_argument("--minimum-free-gib", type=float, default=20.0)
    dev_ready_parser.add_argument("--recommended-free-gib", type=float, default=30.0)
    dev_ready_parser.add_argument("--allow-cloud-worktree", action="store_true")
    dev_ready_parser.add_argument(
        "--format", choices=("text", "json"), default="text"
    )
    dev_ready_parser.set_defaults(handler=check_dev_ready)

    cleanup_parser = subparsers.add_parser(
        "plan-cleanup", help="验证并输出不执行实际操作的清理计划"
    )
    cleanup_parser.add_argument("--worktree", default=".")
    cleanup_parser.add_argument("--base")
    cleanup_parser.add_argument("--base-remote")
    cleanup_parser.add_argument("--push-remote")
    cleanup_parser.add_argument("--merged-pr", required=True)
    cleanup_parser.add_argument(
        "--merge-method", choices=("merge", "squash", "rebase"), required=True
    )
    cleanup_parser.add_argument("--format", choices=("text", "json"), default="text")
    cleanup_parser.set_defaults(handler=plan_cleanup)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        data, status = args.handler(args)
    except GuardError as error:
        data = {
            "operation": args.command,
            "mutates_repository": False,
            "error": str(error),
        }
        status = 2
    output = (
        json.dumps(data, ensure_ascii=False, indent=2)
        if args.format == "json"
        else render_text(data)
    )
    print(output)
    return status


if __name__ == "__main__":
    sys.exit(main())
