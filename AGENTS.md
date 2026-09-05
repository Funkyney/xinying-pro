# 心影Pro：Codex 操作约定

优先通过 `xinying` CLI 操作本地项目和队列，不要通过坐标点击桌面界面。安装版由“Codex扩展”页面在 `$CODEX_HOME/skills/xinying-pro-generate/scripts/` 生成启动器；源码开发环境才使用仓库根目录的 `xinying.cmd`。

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
5. Seedance 自动执行先对图片/视频一次运行 `media cache --file ...`。命中同一 SHA-256 时复用人物检查；未命中才看图或抽取覆盖全片的关键帧。
6. 每张图片和每条视频都必须在清单填写 `containsPerson`。任意帧有人时必须为 `true`，由 APP 强制走虚拟人像授权；无法检查时停止，不能默认填 `false`。
7. 写好导演任务 JSON 后，用户明确要求生成时优先只执行 `director run --manifest <path> --confirm`。该命令内部完成 validate、prepare、authorize、resolve、submit 与状态等待；不要拆成多轮 CLI 轮询。
8. `director run` 返回 `successBoundary: heart-generating` 即成功并立即结束。除非用户另行要求，不继续监控结果，不运行 `job events`、`results sync/list`，也不下载。
9. 人工步骤处理完成后，先复查原网页，再执行 `job resume <job-id> --confirm`，随后只重跑一次 `director run`。

CLI 始终输出 JSON，项目、目录、任务与导演命令默认返回精简字段；诊断时才使用 `--full`。不要依赖界面文案解析本地项目状态。
