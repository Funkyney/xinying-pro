---
name: xinying-pro-generate
description: Use 心影Pro to execute a finished Seedance 2.0/2.5 prompt with ordered local image, video, and audio references; automatically queue required portrait authorization for clearly identified people; preserve the intended @图/@视频/@音频 mapping; submit an explicitly requested number of takes; and stop once every take is confirmed as generating. Trigger when the user says “用心影生成”, “用心影Pro生成”, “把这条提示词跑一下”, “生成 N 条”, or asks Codex to upload references and operate 心影Pro. Only monitor, retrieve, or download results when the user separately asks. Do not use for prompt writing alone or for non-心影 providers.
---

# 心影Pro 自动生成

把 Seedance 导演提示词与电脑上的素材变成一份可校验的导演任务清单，再通过心影Pro的本地 CLI 执行。始终保留提示词中的准确引用关系；心影网页真实编号与计划编号不一致时，由 APP 在提交前回读并改写。

## 安全门禁

- 只有用户明确说“用心影生成/提交/生成 N 条”等会产生任务的指令，才可执行 `director authorize --confirm` 和 `director submit --confirm`。讨论、改提示词、预览和“准备一下”不算提交授权。
- 明确生成但未给数量时，默认 1 条；不要擅自增加数量。一次最多 20 条。
- 将真人或虚拟人物素材标为 `authorizeAsPortrait: true` 前，确认它是用户有权使用的原创、公司或已授权素材。第三方真人、名人、来源不明或授权不清时暂停并询问。
- 不读取或导出 Cookie、Token、二维码、浏览器配置；不绕过登录、验证码、实名、审核、额度、付费确认或地域限制。
- `needs-login` 或 `needs-human` 时报告原始原因，让用户在心影Pro“原网页模式”处理后再恢复。

## 执行流程

### 1. 取得定稿与素材

使用当前对话中 Seedance 2.0 OS 的最终提示词。若提示词还未定稿，先使用 `$seedance-20` 完成提示词，再继续本 Skill。

收集每一个 `@图N / @视频N / @音频N` 对应的绝对本地路径。检查图片内容；视频至少检查首帧、关键帧和尾帧；音频读取时长。根据提示词中引用的先后和媒体类型确定清单顺序，不依赖文件系统排序。

人物判断规则：清晰承担角色身份、需要跨镜头保持身份的人物图或人物视频标记 `authorizeAsPortrait: true`；仅作为动作、构图、场景、服装或风格参考的素材保持普通文件，除非提示词明确要求锁定其中人物身份。

### 2. 定位心影Pro CLI 与当前项目

使用本 Skill `scripts` 目录中的启动器。不要要求用户下载源码或运行 `npm install`。

Windows PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$XinyingCli = Join-Path $CodexRoot "skills\xinying-pro-generate\scripts\xinying.cmd"
& $XinyingCli doctor
```

macOS shell：

```bash
XINYING_CLI="${CODEX_HOME:-$HOME/.codex}/skills/xinying-pro-generate/scripts/xinying"
"$XINYING_CLI" doctor
```

如果启动器不存在或报告的APP路径已失效，停止并让用户在心影Pro的“Codex扩展”页面点击“安装/更新到 Codex”。不要自行搜索或复制用户会话数据。

随后通过同一启动器依次运行：

```text
platform sync
platform catalog
project list
```

选择 `platformProjectId` 与目录 `currentProjectId` 一致的本地项目。没有绑定项目时，先用 `platform open <catalog-project-id>` 打开用户当前选择的心影项目。存在多个合理目标且无法唯一判断时先询问，不要把素材写入猜测的项目。

### 3. 写导演任务清单

在当前镜头文件夹写 `.xinying-run.json`，字段严格遵循 [manifest-schema.md](references/manifest-schema.md)。默认 `replaceMaterials: true`，因为最终顺序必须完全等于清单顺序。把 Seedance 提示词原样放入 `prompt`；只在 APP 回读到心影实际编号后由提交器改写编号。

用启动器运行：

```text
director validate --manifest "<absolute-manifest-path>"
director prepare --manifest "<absolute-manifest-path>"
```

检查输出：素材数量与顺序正确；`preview.orderedLabels` 覆盖提示词中的所有引用；参数与最终提示词一致。`prepare` 只更新本地工作台，不提交心影、不会扣费。

### 4. 自动授权人物素材

仅在安全门禁已满足时运行：

```text
director authorize --manifest "<absolute-manifest-path>" --confirm
```

该命令会为清单中标记的人物素材创建或复用审核任务，名称带稳定短标识，性别、年龄、人种默认“其他”，应用范围默认国内，并由 APP 自动勾选心影合规承诺。

对返回的每个审核任务使用 `job status <job-id>` 轮询。状态为 `queued/submitting/running` 时继续等待；`completed` 后再继续；`failed/needs-login/needs-human` 时停止自动提交并报告。不要因为等待审核而重复创建授权任务。

所有审核完成后运行：

```text
director resolve --manifest "<absolute-manifest-path>"
```

它会同步角色库，把审核通过的人物素材在原清单位置替换为心影虚拟人像。确认输出中人物素材的 `referenceId` 为 `null`、`platformPortraitId` 非空，并且 `preview.orderedLabels` 仍与计划一致。

### 5. 按数量提交生成

再次检查 `preview.ready === true`、`warnings` 为空、没有尚未解析的人像素材，然后执行：

```text
director submit --manifest "<absolute-manifest-path>" --confirm
```

清单中的 `count` 就是生成条数；仅在用户本次指令明确改变数量时使用 `--count N` 覆盖。命令返回统一 `batchId` 和每条任务的 `job id`。APP 会依次上传素材、核验心影实际编号、重写提示词编号并提交。

### 6. 确认进入生成中，然后结束

`director submit` 只代表任务已进入本地队列。对返回的每个生成任务运行 `job status <job-id>`，直到每条任务分别满足以下一种状态：

- `running`：心影已接受提交并显示生成中，视为本自动流程成功。
- `completed`：任务在检查前已快速完成，同样视为提交成功。
- `queued/submitting`：尚未确认心影接单，继续以合理间隔检查。
- `failed/needs-login/needs-human/cancelled`：停止并报告原始原因，不能声称成功。

当本批次全部任务均为 `running` 或 `completed` 时，立即结束 Codex 流程。只汇报批次编号、成功提交数量、任务 ID，并明确说明“心影已进入生成中，自动流程已完成；结果由用户稍后人工查看”。不要继续等待视频完成，不要默认运行 `job events`、`results sync`、`results list` 或下载命令。

只有用户在生成提交之后另行明确要求“继续监控 / 查结果 / 下载”时，才恢复相应查询；这属于新的后续任务，不属于默认生成流程。

## 失败恢复

- 授权已通过但清单仍显示本地参考图：运行 `director resolve`，不要重复授权。
- `PORTRAIT_AUTHORIZATION_PENDING`：先完成审核并 resolve；不要去掉人物标记规避门禁。
- `PROJECT_NOT_READY`：按 `preview.warnings` 修复提示词引用、模型、画幅、时长或项目绑定。
- 心影素材编号变化：让 APP 的提交器处理；若它安全停止，检查任务事件，不手工猜编号后强行重提。
- APP 未运行：启动心影Pro并等待本地控制端口恢复；如登录失效，让用户扫码。
