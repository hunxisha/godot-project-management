# AGENTS.md

## Git 提交约定

修改本项目的文件后，需自动用 git 提交本次变更，无需再单独确认。

提交流程：

1. 先执行 `git status` 和 `git diff`，确认本次改动范围，只提交与本次任务相关的文件。
2. 用 `git add` 指定具体文件路径，禁止使用 `git add .` 或 `git add -A`，避免误提交 `.env`、密钥、凭据或大体积二进制文件。
3. 提交信息用中文，一句话概括改动目的，与本仓库已有提交风格保持一致（如「修复 zip 备份报错」「市场页新增浏览模式标签」）。通过 heredoc 传入 message。
4. 提交后用 `git status` 确认工作区状态。

禁止事项：

- 不执行 `git push`，需要推送时先向用户确认。
- 不使用 `git push --force` / `--force-with-lease`、`git reset --hard`、`git checkout .`、`git clean -f` 等破坏性命令。
- 不修改 git config。
