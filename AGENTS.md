# AGENTS.md

## Git 提交与推送约定

修改本项目的文件后，需自动用 git 提交本次变更，并自动推送到 GitHub，均无需再单独确认。

提交流程：

1. 先执行 `git status` 和 `git diff`，确认本次改动范围，只提交与本次任务相关的文件。
2. 用 `git add` 指定具体文件路径，禁止使用 `git add .` 或 `git add -A`，避免误提交 `.env`、密钥、凭据或大体积二进制文件。
3. 提交信息用中文，一句话概括改动目的，与本仓库已有提交风格保持一致（如「修复 zip 备份报错」「市场页新增浏览模式标签」）。通过 heredoc 传入 message。
4. 提交后自动推送：`git -c http.proxy=http://127.0.0.1:7897 push`（远端 origin = github.com/hunxisha/godot-project-management，直连会被重置，必须走本机 7897 代理；代理只用单次 `-c` 参数）。
5. 推送后用 `git status` 确认工作区干净且与远端同步。

## 打包与发布约定

**打包（zpx）与发布（版本号 bump、CHANGELOG 发版段落、GitHub Release）只在用户明确要求时才执行。**

- 改完代码默认只做「提交 + 推送」同步，**不 bump 版本号、不打包、不发 Release**。
- 用户明确说「打包」「发版」「发布」时，才走完整发版流程：三处版本号同步 → CHANGELOG 新段落（含断言数）→ `npm run build` → zpx 打包到 `E:\ZTools插件开发\zpx插件包` → 创建 GitHub Release 并附 zpx。
- 不擅自判断「这次改动值得发版」——版本节奏由用户决定。

禁止事项：

- 不使用 `git push --force` / `--force-with-lease`、`git reset --hard`、`git checkout .`、`git clean -f` 等破坏性命令。
- 不修改 git config（代理、凭据等都通过单次 `-c` 参数传递）。
