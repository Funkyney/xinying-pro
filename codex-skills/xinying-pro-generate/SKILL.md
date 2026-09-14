---
name: xinying-pro-generate
description: Use 心影Pro to execute a finished Seedance 2.0/2.5 prompt with ordered image, video, and audio references; inspect every image and video for people, require every asset containing any visible real or virtual person to pass 心影 virtual-portrait authorization instead of ordinary reference upload, preserve the intended @图/@视频/@音频 mapping, submit an explicitly requested number of takes, and stop once every take is confirmed as generating. Trigger when the user says “用心影生成”, “用心影Pro生成”, “把这条提示词跑一下”, “生成 N 条”, or asks Codex to upload references and operate 心影Pro. Only monitor, retrieve, or download results when the user separately asks. Do not use for prompt writing alone or for non-心影 providers.
---

# 心影Pro 极速生成

把已定稿的 Seedance 提示词和本地素材写成导演清单，然后优先用心影Pro MCP 的一次 `generate` 调用完成准备、人物授权、原位替换、批量提交和“生成中”确认。MCP 不可用时才回退到一次 `director run`。不要把目录同步、授权轮询和生成轮询拆成多轮调用。

## 安全门禁

- 只有用户明确说“用心影生成/提交/生成 N 条”等会创建任务时，才可运行带 `--confirm` 的提交命令。讨论、改提示词和预览不算授权。
- 未指定数量时只生成 1 条；不得擅自增加，一次最多 20 条。
- 将人物素材送审前，确认它是用户有权使用的原创、公司或已授权素材。第三方真人、名人、来源不明或授权不清时暂停询问。
- 图片或视频的任意画面/帧只要出现真人、虚拟人物或人形角色，无论大小、清晰度、正背面或是否在背景，都必须走心影虚拟人像授权。绝不按普通图片或普通视频兜底，也不能改成 `scene/style/motion/other` 绕过。
- 不读取或导出 Cookie、Token、二维码或浏览器配置；不绕过登录、验证码、实名、审核、额度、付费确认或地域限制。

## 1. 取得提示词、素材和项目

使用当前任务中 Seedance 2.0 OS 已定稿的提示词。未定稿时先调用 `$seedance-20`，定稿后再执行本 Skill。

收集每个 `@图N / @视频N / @音频N` 对应的绝对路径，顺序以提示词意图为准，不能依赖文件系统排序。优先复用镜头文件夹中已有的 `.xinying-run.json` 和其中的 `projectId`。

先检查当前 Codex 是否已提供心影Pro MCP 工具（`status/catalog/conversations/select/generate/jobs/portraits/results`）。已提供时只调用 MCP；它会连接或自动启动心影Pro，并复用 APP 内登录态。需要查项目时先用 `catalog` 的本地缓存，只有用户要求刷新或缓存确实过期才传 `force: true`；需要复用对话时用 `conversations`，随后用 `select` 绑定精确对话。

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

## 2. 人物检查（先查缓存）

在重新看图或抽帧前，对全部图片和视频一次运行：

```text
media cache --file "<path1>" "<path2>" ...
```

- `hit: true`：这是同一文件 SHA-256 的已记录结果，直接复用 `containsPerson`，无需再次看图或视频。
- `hit: false`：图片逐张检查；视频检查首帧、尾帧和覆盖全片的关键帧，不能只看封面。
- 无法打开、无法抽帧或无法确认是否有人时暂停；绝不能默认写 `false`。

每个图片/视频必须在清单中显式填写 `containsPerson`。有人写 `true` 并写 `authorizeAsPortrait: true`；只有确认整项完全无人时才写 `false`。人物硬门禁会把已知含人的同一文件锁为人物素材，后续清单不能将其降级。

多人合照、背脸、脸部过小或人物不完整仍原样写 `true`。不要在 Codex 侧预判审核失败；内部会通过 `director authorize` 原样提交心影虚拟人像审核。只有心影实际返回失败后才报告原因，不能退回普通上传。

素材上限：Seedance 2.5 最多 30 图、10 视频、10 音频，合计最多 50 项，视频和音频总时长各不超过 30 秒；Seedance 2.0 最多 9 图、3 视频、3 音频，合计最多 15 项。

## 3. 写清单并一次执行

在镜头文件夹写 `.xinying-run.json`，严格遵循 [manifest-schema.md](references/manifest-schema.md)。默认 `replaceMaterials: true`，确保清单顺序就是心影最终顺序。提示词原样写入 `prompt`；APP 会按心影实际素材编号自动重写 `@图/@视频/@音频`。

Seedance 2.5 默认写 `videoFormat: "mp4"` 与 `networkEnabled: true`；用户明确要 MOV 时改为 `mov`，明确关闭联网时才写 `false`。APP 会在高级配置中确认。

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
2. 复用相同文件已通过的虚拟人像，其他含人图片/视频分别使用干净表单，自动填写名称、默认资料和合规承诺后排队审核；
3. 在 APP 内部等待审核、持久化阶段检查点、自动恢复临时表单/连接错误、回绑新角色，并把人物素材在原位置替换为已授权虚拟人像；
4. 按 `count` 依次提交，后续条目复用上一条心影对话；
5. 所有任务达到 `running` 或 `completed` 后返回一个精简 JSON。

返回 `successBoundary: "heart-generating"` 且全部任务均为 `running` 或 `completed` 时，立即结束 Codex 流程。只汇报批次编号、数量和任务 ID，并说明“心影已进入生成中，自动流程已完成；结果由用户稍后人工查看”。不要默认运行 `job events`、`results sync`、`results list` 或下载命令。只有用户另行明确要求“继续监控 / 查结果 / 下载”时再做后续查询。

## 失败恢复

- `APP_NOT_RUNNING/needs-login`：让用户启动 APP 或扫码后，继续原任务。
- 上传表单残留、资料下拉框暂时不可用、角色库刚审核完尚未重绘、角色卡编号或图片/视频类型变化：全部由 APP 内部自动清理、重试、回绑和重写编号；不要执行 `job resume`，不要让用户删除重传、改提示词或进入网页补操作。
- MCP 连接中断、`write EOF`、页面上下文失效、SQLite 暂时繁忙或心影提示任务占用：APP 会按检查点有限重试；如果生成按钮附近已经记录 `pending-chat`，每次恢复都必须先查重，绝不能直接再次点击生成。
- `DIRECTOR_AUTHORIZATION_BLOCKED/needs-human`：只报告命令最终返回的真实原因。只有登录失效、心影明确驳回、授权/权限不足、付费确认或平台持续故障才让用户进入“原网页模式”处理。
- 多人、背脸、远景或人物不完整：仍按含人素材送审，不得自行拆图或降级。只有心影表单、接口或审核任务明确返回失败后才暂停。
- `DIRECTOR_NOT_READY/PROJECT_NOT_READY`：按返回的精简 `warnings` 修复引用、模型、参数或项目绑定。
- 含人图片或视频仍出现在最终 `preview.references`：停止提交并纠正清单；绝不按普通图片或普通视频兜底。
- 心影编号变化以及视频人像被角色槽显示为 `@图N` 的情况由 APP 回读并自动改写提示词；不要手工猜编号或要求重新上传。
