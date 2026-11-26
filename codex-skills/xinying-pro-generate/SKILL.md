---
name: xinying-pro-generate
description: Execute finished Seedance prompts through 心影Pro with ordered image, video, and audio references, official automatic image portrait review, separate authorization for person-containing videos, batch submission, and a stop-at-generating success boundary. Use when asked to generate with 心影Pro or upload references and submit takes; not for prompt writing alone. Monitor or download only when separately requested.
---

# 心影Pro 极速生成

把已定稿的 Seedance 提示词和本地素材写成导演清单，然后优先用心影Pro MCP 的一次 `generate` 调用完成准备、官方图片自动审核、必要的视频人物授权、编号映射、批量提交和“生成中”确认。MCP 不可用时才回退到一次 `director run`。不要把目录同步、授权轮询和生成轮询拆成多轮调用。

## 安全门禁

- 只有用户明确说“用心影生成/提交/生成 N 条”等会创建任务时，才可运行带 `--confirm` 的提交命令。讨论、改提示词和预览不算授权。
- 未指定数量时只生成 1 条；不得擅自增加，一次最多 20 条。
- 本次生成授权覆盖清单内用户有权使用的原创、公司或已授权素材，不要逐张重复询问或要求用户手点授权。出现第三方真人、名人、来源不明或授权不清的具体证据时再暂停询问。
- 图片优先开启官网 `autoPortraitAudit: true`，作为参考图上传并由官网自动分析、审核、录入角色库；不要重复创建图片虚拟人像授权任务。APP 必须在上传/提交前确认官方开关实际生效，缺失或审核失败就停止，不能关闭审核兜底。
- 官网自动审核仅覆盖图片。视频的任意帧包含人物时仍须虚拟人像授权；不支持图片自动审核的模型也保留独立授权。不能改角色字段绕过审核。
- 官网说明自动图片审核为实验功能、可能失败；请勿传入真人形象 IP。角色库满 300 项时官网会自动删除最旧素材。开启视为同意官网《虚拟人像素材合规承诺与授权确认书》。
- 不读取或导出 Cookie、Token、二维码或浏览器配置；不绕过登录、验证码、实名、审核、额度、付费确认或地域限制。

## 1. 取得提示词、素材和项目

使用当前任务中 Seedance 2.0 OS 已定稿的提示词。未定稿时先调用 `$seedance-20`，定稿后再执行本 Skill。

收集每个 `@图N / @视频N / @音频N` 对应的绝对路径，顺序以提示词意图为准，不能依赖文件系统排序。优先复用镜头文件夹中已有的 `.xinying-run.json` 和其中的 `projectId`。

先检查当前 Codex 是否已提供心影Pro MCP 工具（`status/catalog/conversations/select/generate/jobs/portraits/results`）。已提供时只调用 MCP；它会连接或自动启动心影Pro，并复用 APP 内登录态。已有有效本地 `projectId` 和绑定对话时直接 `generate`，不例行调用 `status/catalog/conversations/select/portraits`，也不先校验一遍再提交一遍。确实缺少项目时才查 `catalog` 本地缓存，用户要求刷新或缓存过期才传 `force: true`；需要选择另一对话时用 `conversations`，随后用 `select` 绑定精确对话。

只有当前 Codex 会话尚未加载心影Pro MCP 时，才使用本 Skill 的 CLI 启动器；不要求用户下载源码或执行 `npm install`：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$XinyingCli = Join-Path $CodexRoot "skills\xinying-pro-generate\scripts\xinying.cmd"
& $XinyingCli doctor
```

```bash
XINYING_CLI="${CODEX_HOME:-$HOME/.codex}/skills/xinying-pro-generate/scripts/xinying"
"$XINYING_CLI" doctor
```

启动器缺失或 APP 路径失效时，让用户在心影Pro“Codex扩展”页点击安装/更新。已有有效 `projectId` 时不要例行运行 `platform sync/catalog/project list`。只有项目缺失、用户切换空间/项目或本地目录确实过期时才运行 `platform sync`；它默认复用十分钟缓存，需要强制刷新时加 `--force`。已绑定项目保留 `platformUrl` 的 `sessionId`，不要再次 `platform open` 误建新对话。

## 2. 图片自动审核，视频保留人物检查

Seedance 2.0 / 2.5 默认在清单设置 `autoPortraitAudit: true`。图片可以省略 `containsPerson` 和 `personCheck`，无需为了路由而逐张看图、查询人物缓存或调用 JEV，也不要填写 `authorizeAsPortrait: true`。图片仍可标为 `role: character`，保持创作语义与素材顺序；出现在 `preview.references` 是此模式的正常状态，不表示绕过审核。

这条图片路径不需要人工点授权、单独上传角色库或等待角色库同步。旧清单里即使保留 `containsPerson: true` / `authorizeAsPortrait: true`，APP 也应按已开启的官网图片审核路径执行，不能因此重复送审。上传文件直接交给 APP 的同机路径接口，不把图片转成 Base64 放进 MCP；批量超过 50 MiB 也不要求用户压缩，但仍受官网各素材限制约束。

仅对视频，或用户关闭/模型不支持自动图片审核时的图片，一次执行 `media cache --file` 查询 SHA-256 缓存。命中则复用；未命中时视频检查首帧、尾帧和覆盖全片的关键帧，图片逐张检查。无法检查时停止，不猜测无人。

这些需独立路由的素材，结论明确时填写 `containsPerson`：有人为 `true` 并设 `authorizeAsPortrait: true`；确认整项无人为 `false`。结论不稳时不要猜布尔值，可填写实际视觉证据 `personCheck: { verdict, confidence, summary, inspectedFrames, inspectionComplete }`，由 APP 的缓存/规则/JEV 路由。JEV 不读取媒体文件，不能代替视觉检查。

多人、背脸、远景或人物不完整时不要在 Codex 侧预判审核失败；仍交官网相应审核流程。只有官网实际拒绝才报告原因，不能把含人视频降级为普通视频上传。

视频保留 APP 卡片上的手动授权入口。自动生成时，含人物视频的角色库上传、合规勾选、审核等待和回绑由 APP 在后台自动执行，不再要求用户逐项手点；官网明确拒绝、登录失效或最终 `needs-human` 时才提示用户处理。当前官网帮助仍注明含人视频需录入角色库，不能把图片开关解释成视频已获审核。

素材上限：Seedance 2.5 最多 30 图、10 视频、10 音频，合计最多 50 项，视频和音频总时长各不超过 30 秒；Seedance 2.0 最多 9 图、3 视频、3 音频，合计最多 15 项。

## 3. 写清单并一次执行

在镜头文件夹写 `.xinying-run.json`，严格遵循 [manifest-schema.md](references/manifest-schema.md)。默认 `replaceMaterials: true`，确保清单顺序就是心影最终顺序。提示词原样写入 `prompt`；APP 会按心影实际素材编号自动重写 `@图/@视频/@音频`。

Seedance 2.0 / 2.5 默认写 `autoPortraitAudit: true`、`videoFormat: "mp4"` 与 `networkEnabled: true`；2.5 用户明确要 MOV 时改为 `mov`，明确关闭联网时才写 `false`。两者均支持 4K；APP 会在高级配置中确认，具体可用性以当前账号和模型为准。

可选新增参数：`promptOptimizer`（默认 false，避免改动定稿提示词）、`draftMode`（480P MP4 样片）、`smartBalance`（官网智能均衡，可能更慢但省积分）、`inspiration`（官网分类到镜头名称的映射）。仅在用户要求且官网当前模型支持时启用；需要灵感镜头名称或确认能力时调用一次只读 `generation_options`，不要编造预设名称，也不要每次生成都查询。样片模式会关闭智能均衡并锁定 480P MP4；样片后续高清渲染在原网页操作。

安全门禁满足后，首选只调用一次心影Pro MCP `generate`：

```json
{"manifestPath":"<absolute-manifest-path>","requestId":"<stable-id-for-this-user-request>","confirm":true}
```

同一次用户生成指令必须始终复用相同的 `requestId`，包括 MCP 返回中断后的重试；用户明确要求再生成一批时才更换 `requestId`。这样 APP 会复用已有任务，防止重复点击生成和重复扣费。用户明确改变数量时增加 `count: N`。MCP 会保持到整个流程返回，不要同时再启动 CLI 或第二次 `generate`。

当前 Codex 会话没有心影Pro MCP 时，才执行：

```text
director run --manifest "<absolute-manifest-path>" --confirm
```

用户本次明确改变数量时追加 `--count N`。允许该进程持续运行，工具初次返回后台会话后继续等待同一会话；不要另开 `job status`、`director resolve` 或重复 `director run`，也不要在任务仍运行时让用户去网页补操作。默认总等待上限 45 分钟，可用 `--timeout-minutes N` 调整。长时间等待由同一个本地进程完成，不要用多轮 Codex 对话或轮询消耗额外 token。

这一次 MCP 调用或回退命令会：

1. 校验清单并按顺序配置本地项目；
2. 图片在官方自动审核开启时按参考图直接上传；含人视频或未开启自动审核的图片才复用/创建独立虚拟人像授权；
3. APP 确认官方参数生效；需要独立授权的素材等待审核后原位替换。图片自动审核由官网生成流程执行，失败不能伪报成功；
4. 按 `count` 依次提交，后续条目复用上一条心影对话；
5. 所有任务达到 `running` 或 `completed` 后返回一个精简 JSON。

返回 `successBoundary: "heart-generating"` 且全部任务均为 `running` 或 `completed` 时，立即结束 Codex 流程。只汇报批次编号、数量和任务 ID，并说明“心影已进入生成中，自动流程已完成；结果由用户稍后人工查看”。不要默认运行 `job events`、`results sync`、`results list` 或下载命令。只有用户另行明确要求“继续监控 / 查结果 / 下载”时再做后续查询。

## 失败恢复

- `APP_NOT_RUNNING/needs-login`：让用户启动 APP 或扫码后，继续原任务。
- 上传表单残留、资料下拉框暂时不可用、角色库刚审核完尚未重绘、角色卡编号或图片/视频类型变化：全部由 APP 内部自动清理、重试、回绑和重写编号；不要执行 `job resume`，不要让用户删除重传、改提示词或进入网页补操作。
- MCP 连接中断、`write EOF`、页面上下文失效、SQLite 暂时繁忙或心影提示任务占用：APP 会按检查点有限重试；如果生成按钮附近已经记录 `pending-chat`，每次恢复都必须先查重，绝不能直接再次点击生成。
- `DIRECTOR_AUTHORIZATION_BLOCKED/needs-human`：只报告命令最终返回的真实原因。只有登录失效、心影明确驳回、授权/权限不足、付费确认或平台持续故障才让用户进入“原网页模式”处理。
- 多人、背脸、远景或人物不完整：按当前官方审核路径提交，不得自行拆图或降级。
- `DIRECTOR_NOT_READY/PROJECT_NOT_READY`：按返回的精简 `warnings` 修复引用、模型、参数或项目绑定。
- 开启官方自动图片审核时，含人图片保留在 `preview.references` 是正确路径；含人视频或未启用该功能的含人图片仍须独立授权后替换。审核开关缺失、审核失败或权限不足时报告真实原因。
- 心影编号变化以及视频人像被角色槽显示为 `@图N` 的情况由 APP 回读并自动改写提示词；不要手工猜编号或要求重新上传。
