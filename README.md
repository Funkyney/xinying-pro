# 心影Pro

心影Pro（AgentLab Pro）是 Windows / macOS 桌面客户端：用更清晰的项目、素材和任务界面控制心影官方网页流程。登录、审核、生成、额度和结果仍由心影处理；应用不调用未公开接口。

## 已实现能力

- 在 Electron 内嵌心影官方页面，通过飞书二维码扫码登录，并使用独立持久会话。
- 同步心影“个人空间 / 团队空间 / 项目”目录，在 APP 内搜索、切换或新建项目；个人空间明确标记为仅自己可见，团队空间明确标记为成员互通。未选择并进入心影项目前，生成工作台保持门禁状态。
- 项目创建、重命名、说明、删除，以及心影生成链接、模型、提示词、画幅、时长、分辨率和声音参数管理；Seedance 2.5 与 Seedance 2.0 是一等模型选项，参数会按心影当前能力联动。
- 已授权虚拟人像与本地图片、视频、音频进入同一个“APP 创作编号”面板，可任意穿插并直接拖动排序。APP 按心影真实规则分别显示 `@图N / @视频N / @音频N`；视频角色会从心影 `.mp4` 快照自动识别为 `@视频N`。
- 生成工作台提供统一共享素材库，按“全部 / 虚拟人像 / 图片 / 视频 / 音频”分类、计数和搜索。图片、视频、音频上传后作为 APP 级母版跨项目复用，直接上传或替换项目素材时也会自动入库并按内容哈希去重；点击卡片加入当前项目，再次点击移出。删除共享母版不会删除各项目已有的独立副本。
- 本地参考素材支持用途标记、单项替换和等量批量替换；心影实机支持的格式为图片 `.jpeg/.jpg/.png`、视频 `.mp4/.mov`、音频 `.wav/.mp3`。心影会按媒体类型重新排列网页卡片，因此 APP 提交时逐项比较加入前后的编号差异，把新增 `@图/@视频/@音频` 精确映射回 APP 顺序；媒体类型或提示词引用不一致时会在点击生成前停止并清空平台草稿，避免错号扣费。
- 生成入队时复制每张参考图为任务专属不可变快照；之后替换、重排或删除项目素材不会改变已排队任务。
- 心影认证角色库按当前空间同步：团队库包含同事已授权上传的共享人像，可切换“最新上传优先 / 最早上传优先”。共享库提供独立批量管理模式，可多选或全选当前筛选结果；只有心影明确显示删除入口的角色才可勾选，永久删除前会再次展示空间、数量和名称并要求确认。普通模式下仍可点击角色加入上方统一素材面板并调整 APP 创作编号；心影若强制重排 V 角色，提交器会按稳定素材 ID 回读并改写提示词引用。
- 新虚拟人像的本地合规确认、角色库上传和审核状态同步；普通参考图也提供“授权为虚拟人像”入口。名称自动取文件名，性别/年龄/人种默认“其他”，应用范围默认国内版。用户明确勾选并记住与心影一致的合规声明后，后续单击会在卡片内依次显示“授权中 / 已授权”，同一参考图不会重复建任务；心影表单在屏幕外自动完成，不再覆盖 APP 工作区。
- SQLite 异步任务台账：排队、提交、生成、完成、失败、需要登录、需要人工处理和取消；桌面端可展开查看参数、参考图与事件记录。
- APP 在点击生成前持久化预期对话位置；提交阶段异常退出时转为人工检查，恢复后优先配对既有对话，避免重复付费提交。
- 结果库可同步当前心影项目所有会话中的已生成视频，支持多选、全选、批量下载、批量标记/取消标记。播放器提供当前视频下载和左右切换；关闭后会自动滚回并高亮最后查看的卡片。
- Playwright 通过 Electron 本地 CDP 通道操作心影的可见页面元素。
- 主界面启用 Electron 渲染沙箱；`xinying.cmd` 为 Codex 提供无 npm 日志前缀的稳定 JSON 输出。

## 本地开发

要求：Windows 10/11 或 macOS、Node.js 24 或兼容版本、可访问心影与飞书。

```powershell
npm install
npm run dev
```

首次运行：

1. 点击左下角“扫码登录”，或进入“原网页模式”。
2. 使用本人飞书扫描心影官方二维码。
3. 进入“空间与项目”，点击“同步心影”，选择个人空间或团队空间下的既有项目；也可填写心影真实的客户和创作类型来新建项目。
4. APP 自动进入所选项目并建立生成会话，随后才会开放生成工作台。
5. 在共享素材库上传图片、视频或音频，或直接向项目添加素材；二者都会保存为可跨项目复用的共享母版。使用分类或搜索定位后，点击卡片加入当前项目。
6. 共享虚拟人像位于同一素材库的“虚拟人像”分类；点击后立即出现在上方参考素材中。图片角色使用 `@图N`，视频角色使用 `@视频N`，所有类型均可自由混排和拖动。提示词可写 `@图1`、`@图一` 或“参考图三”；APP 会在提交时统一识别并换算为心影的实际编号。
7. 点击“预览提交”，核对编号和参数后再确认。

应用数据默认保存在：

```text
%APPDATA%\xinying-director
```

测试或多环境运行可设置 `XINYING_DATA_DIR` 指向独立目录。

## Codex / CLI

先构建：

```powershell
npm run build
.\xinying.cmd doctor
```

常用示例：

```powershell
.\xinying.cmd platform sync
.\xinying.cmd platform catalog
.\xinying.cmd platform open <catalog-project-id>
.\xinying.cmd platform create --workspace-id <workspace-id> --name "汽车广告" --customer "其他测试" --creation-type "其他" --confirm
.\xinying.cmd project create --name "汽车广告" --mode reference-to-video --model "Seedance 2.5 全能参考" --platform-url "https://blueaivideo.com/avpAgent?projectId=…&sessionId=…"
.\xinying.cmd project create --name "4K参考片" --mode reference-to-video --model "Seedance 2.0 全能参考" --resolution 4k
.\xinying.cmd refs add <project-id> --file "C:\assets\car.png" "C:\assets\street.png"
.\xinying.cmd refs reorder <project-id> --ids <ref-2>,<ref-1>
.\xinying.cmd library add --file "C:\assets\car.png" "C:\assets\motion.mp4" "C:\assets\music.mp3"
.\xinying.cmd library list
.\xinying.cmd library project-add <shared-media-id> --project-id <project-id>
.\xinying.cmd library project-remove <shared-media-id> --project-id <project-id>
.\xinying.cmd job preview <project-id>
.\xinying.cmd job submit <project-id> --confirm
.\xinying.cmd job status <job-id>
.\xinying.cmd job events <job-id>
.\xinying.cmd job resume <job-id> --confirm
.\xinying.cmd job download <job-id> --output "C:\outputs\result.mp4"
.\xinying.cmd portrait update <portrait-id> --name "角色A" --gender "其他" --age-group "其他" --ethnicity "其他" --scope domestic
.\xinying.cmd portrait platform-sync --project-id <project-id>
.\xinying.cmd portrait platform-list --workspace-id <workspace-id>
.\xinying.cmd portrait platform-delete --project-id <project-id> --ids <portrait-id-1>,<portrait-id-2> --confirm
.\xinying.cmd portrait authorize-reference <reference-id> --project-id <project-id> --confirm
.\xinying.cmd project update <project-id> --portrait-ids <platform-portrait-id-1>,<platform-portrait-id-2>
.\xinying.cmd project update <project-id> --portrait-ids <portrait-1>,<portrait-2> --material-order reference:<ref-1>,portrait:<portrait-1>,portrait:<portrait-2>,reference:<ref-2>
.\xinying.cmd results sync --project-id <project-id>
.\xinying.cmd results list --project-id <project-id> --compact
.\xinying.cmd results mark --ids <result-id-1>,<result-id-2> --value true
.\xinying.cmd results batch-download --ids <result-id-1>,<result-id-2> --output-dir "C:\outputs"
```

新项目的分辨率默认是 `auto`：提交时沿用心影当前模型页面已经选中的分辨率。当前实机能力为：Seedance 2.5 支持 `480p / 720p / 1080p`、时长 4–30 秒；Seedance 2.0 支持 `480p / 720p / 1080p / 4k`、时长 4–15 秒。4K 只会在 Seedance 2.0 下显示和通过校验。

`xinying.cmd` 不经过 npm 的日志包装，标准输出只有 CLI JSON，适合 Codex 直接解析。CLI 写入与桌面 APP 共用的 SQLite 队列；`platform sync/open/create`、`portrait platform-sync/platform-delete`、`results sync` 会通过仅监听本机的 APP 控制通道调用当前已登录页面，因此桌面 APP 必须保持运行。新建心影项目、生成、审核、取消和删除等外部写操作要求 `--confirm`；成功、帮助和用法错误均输出可解析 JSON。

## 验证和构建

```powershell
npm run typecheck
npm test
npm run build
npm run verify:cli
npm run icons
npm run pack:win
# macOS 或 GitHub Actions 的 Mac runner：
npm run pack:mac
```

安装包默认输出到 `release/`。Windows 使用 NSIS 安装包；macOS 同时生成通用架构的 DMG 和 ZIP，可原生运行在 Intel 与 Apple Silicon Mac 上。未配置商业签名证书时，Windows 可能显示未知发布者，macOS 可能被 Gatekeeper 阻止。

## GitHub 发布与应用内更新

`.github/workflows/release.yml` 会在 `main` 分支每次推送后运行验证，并分别在 GitHub 的 Windows 和 macOS runner 上构建安装包。发布版本沿用 `package.json` 的主版本与次版本，并把 GitHub Actions 运行序号作为补丁版本；例如基线 `0.5.0` 的首次发布会生成类似 `0.5.1` 的版本。流水线会创建 GitHub Release，并上传 Windows 的 `latest.yml`、NSIS 安装包，以及 macOS 的 `latest-mac.yml`、DMG 和 ZIP。

APP 顶部提供“检查更新”按钮：发现新版后可下载，完成后点击“重启安装”。公开 GitHub Releases 可供同事匿名更新；私有仓库不能把 GitHub Token 硬编码进客户端，应改用公开的二进制发布仓库或公司更新服务器。

macOS 自动更新必须使用 Developer ID 签名。为 GitHub 仓库配置以下 Actions Secrets 后，electron-builder 会在 Mac runner 上自动签名并提交 Apple 公证：

- `MAC_CSC_LINK`：Developer ID Application 证书导出的 `.p12`（可用 Base64 内容或受保护链接）。
- `MAC_CSC_KEY_PASSWORD`：该 `.p12` 的密码。
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：Apple 公证凭据。

不要把证书、密码、GitHub Token、心影/飞书登录数据提交到仓库。每位同事首次使用仍需自行飞书扫码登录。

## 人工接管

以下情况不会自动绕过，任务会暂停：

- 飞书扫码或登录失效
- 验证码、安全验证、实名验证
- 虚拟人像审核被平台拒绝、表单字段变化或已记住的合规确认不可验证
- 付费确认
- 心影页面改版导致定位不明确

进入“原网页模式”处理后，在任务队列点击“恢复”；CLI 使用 `job resume <id> --confirm`。详见 [适配器维护说明](docs/ADAPTER_MAINTENANCE.md)、[安全说明](docs/SECURITY.md) 和 [交付验收记录](docs/VERIFICATION.md)。
