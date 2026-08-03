#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence


SCRIPT = Path(__file__).with_name("worktree_guard.py")


def run(command: Sequence[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )


def git(repo: Path, *args: str) -> str:
    return run(("git", "-C", str(repo), *args)).stdout.strip()


class RepositoryFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.remote = root / "remote.git"
        self.primary = root / "Project"
        run(("git", "init", "--bare", str(self.remote)))
        run(("git", "init", "-b", "main", str(self.primary)))
        git(self.primary, "config", "user.name", "测试用户")
        git(self.primary, "config", "user.email", "fixture@example.com")
        self.primary.joinpath("README.md").write_text("# 测试仓库\n", encoding="utf-8")
        git(self.primary, "add", "README.md")
        git(self.primary, "commit", "-m", "chore: 初始化测试仓库")
        git(self.primary, "remote", "add", "origin", str(self.remote))
        git(self.primary, "push", "-u", "origin", "main")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        git(self.primary, "remote", "set-head", "origin", "--auto")

    def add_task_worktree(self, slug: str = "sample-feature") -> tuple[Path, str]:
        branch = f"feat/{slug}"
        worktree = self.root / f"Project-wt-feat-{slug}"
        git(
            self.primary,
            "worktree",
            "add",
            "-b",
            branch,
            str(worktree),
            "origin/main",
        )
        git(worktree, "config", "user.name", "测试用户")
        git(worktree, "config", "user.email", "fixture@example.com")
        worktree.joinpath("feature.txt").write_text("功能\n", encoding="utf-8")
        git(worktree, "add", "feature.txt")
        git(worktree, "commit", "-m", "feat: 添加示例功能")
        git(worktree, "push", "-u", "origin", branch)
        return worktree, branch

    def use_fork_remote_model(self) -> None:
        fork = self.root / "fork.git"
        run(("git", "clone", "--bare", str(self.remote), str(fork)))
        git(self.primary, "remote", "set-url", "origin", str(fork))
        git(self.primary, "remote", "add", "upstream", str(self.remote))
        git(self.primary, "fetch", "--prune", "origin")
        git(self.primary, "fetch", "--prune", "upstream")
        git(self.primary, "remote", "set-head", "origin", "--auto")
        git(self.primary, "remote", "set-head", "upstream", "--auto")


class GitHubCollaborationWorktreeGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.fixture = RepositoryFixture(Path(self.temporary_directory.name))

    def guard(self, *args: str) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        result = subprocess.run(
            (sys.executable, str(SCRIPT), *args, "--format", "json"),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        return result, json.loads(result.stdout)

    def test_plan_create_resolves_remote_base_and_names(self) -> None:
        result, data = self.guard(
            "plan-create",
            "--repo",
            str(self.fixture.primary),
            "--type",
            "feat",
            "--slug",
            "123-email-otp",
        )

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(data["base"], "origin/main")
        self.assertEqual(
            data["base_oid"], git(self.fixture.primary, "rev-parse", "origin/main")
        )
        self.assertIn(str(data["base_oid"]), str(data["commands"][-1]))
        self.assertEqual(data["branch"], "feat/123-email-otp")
        self.assertTrue(str(data["worktree_path"]).endswith("Project-wt-feat-123-email-otp"))
        self.assertFalse(data["mutates_repository"])
        self.assertFalse(self.fixture.root.joinpath("Project-wt-feat-123-email-otp").exists())

    def test_default_text_output_and_help_are_chinese(self) -> None:
        result = subprocess.run(
            (
                sys.executable,
                str(SCRIPT),
                "plan-create",
                "--repo",
                str(self.fixture.primary),
                "--type",
                "docs",
                "--slug",
                "chinese-output",
            ),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("操作：规划创建", result.stdout)
        self.assertIn("是否修改仓库：否", result.stdout)
        self.assertIn("工作树路径：", result.stdout)
        self.assertNotIn("operation:", result.stdout)

        help_result = run((sys.executable, str(SCRIPT), "--help"))
        self.assertIn("规划并检查 GitHub 贡献工作树", help_result.stdout)
        self.assertIn("用法：", help_result.stdout)
        self.assertIn("选项", help_result.stdout)
        self.assertIn("显示帮助并退出", help_result.stdout)

        error_result = subprocess.run(
            (sys.executable, str(SCRIPT), "plan-create"),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(error_result.returncode, 2)
        self.assertIn("参数错误", error_result.stderr)
        self.assertIn("缺少必需参数", error_result.stderr)

    def test_fork_model_uses_upstream_base_and_origin_push(self) -> None:
        self.fixture.use_fork_remote_model()

        result, data = self.guard(
            "plan-create",
            "--repo",
            str(self.fixture.primary),
            "--type",
            "fix",
            "--slug",
            "fork-contribution",
        )

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(data["base"], "upstream/main")
        self.assertEqual(data["base_remote"], "upstream")
        self.assertEqual(data["push_remote"], "origin")
        self.assertIn("fetch --prune upstream", "\n".join(data["commands"]))
        self.assertIn("fetch --prune origin", "\n".join(data["commands"]))

        worktree, _ = self.fixture.add_task_worktree("fork-ready")
        ready_result, ready_data = self.guard(
            "check-pr-ready", "--worktree", str(worktree)
        )
        self.assertEqual(ready_result.returncode, 0, ready_result.stdout)
        self.assertTrue(ready_data["ready"])
        self.assertEqual(ready_data["base"], "upstream/main")
        self.assertEqual(ready_data["upstream"], "origin/feat/fork-ready")

    def test_plan_create_rejects_invalid_slug_and_tracked_changes(self) -> None:
        invalid_result, invalid_data = self.guard(
            "plan-create",
            "--repo",
            str(self.fixture.primary),
            "--type",
            "fix",
            "--slug",
            "Bad_Name",
        )
        self.assertEqual(invalid_result.returncode, 2)
        self.assertIn("小写短横线", str(invalid_data["error"]))

        self.fixture.primary.joinpath("README.md").write_text(
            "# 已修改\n", encoding="utf-8"
        )
        dirty_result, dirty_data = self.guard(
            "plan-create",
            "--repo",
            str(self.fixture.primary),
            "--type",
            "fix",
            "--slug",
            "valid-name",
        )
        self.assertEqual(dirty_result.returncode, 2)
        self.assertIn("受跟踪改动", str(dirty_data["error"]))

    def test_check_pr_ready_accepts_clean_current_pushed_branch(self) -> None:
        worktree, _ = self.fixture.add_task_worktree()

        result, data = self.guard(
            "check-pr-ready",
            "--worktree",
            str(worktree),
            "--base",
            "origin/main",
        )

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(data["ready"])
        self.assertFalse(data["dirty"])
        self.assertEqual(data["ahead_base"], 1)
        self.assertEqual(data["behind_base"], 0)
        self.assertEqual(data["ahead_upstream"], 0)

    def test_check_pr_ready_reports_dirty_unpushed_and_behind_states(self) -> None:
        worktree, _ = self.fixture.add_task_worktree()
        worktree.joinpath("feature.txt").write_text("再次修改\n", encoding="utf-8")
        dirty_result, dirty_data = self.guard(
            "check-pr-ready", "--worktree", str(worktree), "--base", "origin/main"
        )
        self.assertEqual(dirty_result.returncode, 1)
        self.assertTrue(dirty_data["dirty"])
        self.assertIn(
            "工作树存在已修改、已暂存或未跟踪文件",
            dirty_data["blocking_reasons"],
        )

        git(worktree, "add", "feature.txt")
        git(worktree, "commit", "-m", "fix: 调整示例功能")
        unpushed_result, unpushed_data = self.guard(
            "check-pr-ready", "--worktree", str(worktree), "--base", "origin/main"
        )
        self.assertEqual(unpushed_result.returncode, 1)
        self.assertIn("分支存在未推送提交", unpushed_data["blocking_reasons"])

        self.fixture.primary.joinpath("base.txt").write_text("基线\n", encoding="utf-8")
        git(self.fixture.primary, "add", "base.txt")
        git(self.fixture.primary, "commit", "-m", "chore: 推进基线")
        git(self.fixture.primary, "push", "origin", "main")
        behind_result, behind_data = self.guard(
            "check-pr-ready", "--worktree", str(worktree), "--base", "origin/main"
        )
        self.assertEqual(behind_result.returncode, 1)
        self.assertIn("分支落后于已经获取的基线", behind_data["blocking_reasons"])

    def test_cleanup_plan_for_squash_requires_evidence_and_never_mutates(self) -> None:
        worktree, branch = self.fixture.add_task_worktree()
        git(self.fixture.primary, "merge", "--squash", branch)
        git(self.fixture.primary, "commit", "-m", "feat: 合并示例功能")
        git(self.fixture.primary, "push", "origin", "main")

        result, data = self.guard(
            "plan-cleanup",
            "--worktree",
            str(worktree),
            "--base",
            "origin/main",
            "--merged-pr",
            "42",
            "--merge-method",
            "squash",
        )

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(data["ready"])
        self.assertEqual(data["remote_branch_action"], "none")
        self.assertIn("branch -D", "\n".join(data["commands"]))
        self.assertTrue(worktree.exists())
        self.assertEqual(
            git(self.fixture.primary, "show-ref", "--verify", f"refs/heads/{branch}"),
            f"{git(worktree, 'rev-parse', 'HEAD')} refs/heads/{branch}",
        )

    def test_cleanup_plan_rejects_dirty_worktree_and_invalid_pr_evidence(self) -> None:
        worktree, _ = self.fixture.add_task_worktree()
        worktree.joinpath("untracked.txt").write_text("请保留\n", encoding="utf-8")

        dirty_result, dirty_data = self.guard(
            "plan-cleanup",
            "--worktree",
            str(worktree),
            "--base",
            "origin/main",
            "--merged-pr",
            "42",
            "--merge-method",
            "squash",
        )
        self.assertEqual(dirty_result.returncode, 1)
        self.assertIn(
            "工作树存在已修改、已暂存或未跟踪文件",
            dirty_data["blocking_reasons"],
        )

        invalid_result, invalid_data = self.guard(
            "plan-cleanup",
            "--worktree",
            str(worktree),
            "--merged-pr",
            "not-a-pr",
            "--merge-method",
            "squash",
        )
        self.assertEqual(invalid_result.returncode, 2)
        self.assertIn("规范 GitHub 拉取请求地址", str(invalid_data["error"]))


if __name__ == "__main__":
    unittest.main()
