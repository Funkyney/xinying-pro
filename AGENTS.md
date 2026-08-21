# 心影Pro：Codex 操作约定

优先通过构建后的 `xinying` CLI 操作本地项目和队列，不要通过坐标点击桌面界面。

## 安全边界

- 查询命令可直接执行。
- `platform create`、`job submit`、`job cancel`、`portrait submit`、`portrait authorize-reference` 和删除命令必须得到用户明确授权，并传入 `--confirm`。
- 不读取或导出心影、飞书的 Cookie、Token、二维码内容或浏览器配置。
- 不绕过验证码、登录、实名、审核、额度、付费或地域限制。
- 遇到任务状态 `needs-login` 或 `needs-human` 时，报告原因并让用户在 APP 的“原网页模式”中处理。

## 推荐顺序

1. `npm run build`
2. `.\xinying.cmd doctor`
3. `.\xinying.cmd platform sync`，再用 `platform catalog` 读取个人/团队空间和项目目录。
4. 用 `platform open <catalog-project-id>` 选择心影项目；新建时使用 `platform create ... --confirm`。
5. `.\xinying.cmd project list`，修改项目前先执行 `project show <id>`。
6. 提交前执行 `job preview <project-id>`，检查 `ready` 与 `warnings`。
7. 用户确认后执行 `job submit <project-id> --confirm`。
8. 使用 `job status <job-id>` 和 `job events <job-id>` 查询进度。
9. 人工步骤处理完成后，先复查原网页，再执行 `job resume <job-id> --confirm`。

CLI 始终输出 JSON。不要依赖界面文案解析本地项目状态。
