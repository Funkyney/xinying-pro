# 心影Pro：Codex 操作约定

优先使用心影Pro MCP 操作本地项目、项目对话和导演生成；一个完整导演任务只调用一次 `generate`。当前 Codex 会话没有加载 MCP 时才通过 `xinying` CLI 操作，不要通过坐标点击桌面界面。安装版由“Codex扩展”页面同时注册 MCP，并在 `$CODEX_HOME/skills/xinying-pro-generate/scripts/` 生成回退启动器；源码开发环境才使用仓库根目录的 `xinying.cmd`。

## 安全边界

- 查询命令可直接执行。
- `platform create`、`job submit`、`job cancel`、`portrait submit`、`portrait authorize-reference`、`director authorize`、`director submit`、`director run` 和删除命令必须得到用户明确授权，并传入 `--confirm`。
- 不读取或导出心影、飞书的 Cookie、Token、二维码内容或浏览器配置。
- 不绕过验证码、登录、实名、审核、额度、付费或地域限制。
- 遇到任务状态 `needs-login` 或 `needs-human` 时，报告原因并让用户在 APP 的“原网页模式”中处理。

## 推荐顺序

1. `npm run build`
2. `.\xinying.cmd doctor`
3. 已知本地项目和会话时不要例行同步目录；`platform sync` 默认复用十分钟缓存，切换项目或确认目录过期时才使用，强制访问网页用 `--force`。
4. 用 `platform open <catalog-project-id>` 选择心影项目；新建时使用 `platform create ... --confirm`。已绑定项目不要重复 open，以免误建新对话。
5. Seedance 2.0 / 2.5 默认使用官网 `autoPortraitAudit: true`：图片直接作为参考图上传，由官网自动分析、审核并辅助录入角色库；不再先做图片人物路由或单独上传授权。APP 必须确认开关生效；不支持或审核失败时停止，不能关闭审核兜底。
6. 官网自动审核仅适用于图片。视频仍先通过 `media cache --file ...` 复用 SHA-256 人物检查；未命中时检查覆盖全片的关键帧。视频必须填写 `containsPerson`；有人为 `true`，走独立虚拟人像授权。关闭自动图片审核的图片也沿用此流程。无法检查时不能默认填 `false`。
7. 写好导演任务 JSON 后，用户明确要求生成时优先只调用 MCP `generate({ manifestPath, requestId, count?, confirm: true })`；同一次用户指令及其重试必须复用相同 `requestId`，只有用户明确要求新增一批时才更换。没有 MCP 时只执行 `director run --manifest <path> --confirm`。两者内部都完成 validate、prepare、authorize、resolve、submit 与状态等待；不要拆成多轮轮询。
8. `director run` 返回 `successBoundary: heart-generating` 即成功并立即结束。除非用户另行要求，不继续监控结果，不运行 `job events`、`results sync/list`，也不下载。
9. 临时连接、页面和表单错误由 APP 自愈引擎自动恢复，不要手动重跑。只有任务最终进入 `needs-login`、`needs-human` 或恢复次数用尽时，才让用户完成明确的人工步骤并恢复原任务。

CLI 始终输出 JSON，项目、目录、任务与导演命令默认返回精简字段；诊断时才使用 `--full`。不要依赖界面文案解析本地项目状态。
