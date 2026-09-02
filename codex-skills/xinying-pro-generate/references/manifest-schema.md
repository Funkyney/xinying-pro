# 心影Pro 导演任务清单

使用 UTF-8 JSON。相对素材路径以清单文件所在目录为基准；推荐写绝对路径。

```json
{
  "version": 1,
  "projectId": "心影Pro本地项目ID",
  "prompt": "@图1 中的人物参考 @音频1 说话，场景参考 @图2。",
  "count": 3,
  "replaceMaterials": true,
  "settings": {
    "name": "镜头 07",
    "description": "可选说明",
    "modelName": "Seedance 2.5 全能参考",
    "mode": "reference-to-video",
    "aspectRatio": "16:9",
    "duration": 8,
    "resolution": "1080p",
    "audioEnabled": true,
    "videoFormat": "mov",
    "networkEnabled": true
  },
  "materials": [
    {
      "kind": "file",
      "path": "C:\\shots\\07\\actor.png",
      "containsPerson": true,
      "role": "character",
      "authorizeAsPortrait": true
    },
    {
      "kind": "file",
      "path": "C:\\shots\\07\\dialogue.wav",
      "role": "other"
    },
    {
      "kind": "file",
      "path": "C:\\shots\\07\\empty-room.mp4",
      "containsPerson": false,
      "role": "motion"
    },
    {
      "kind": "platform-portrait",
      "portraitId": "已同步的心影Pro虚拟人像ID"
    }
  ]
}
```

## 字段

- `version`：固定为 `1`。
- `projectId`：心影Pro本地项目 ID，不是网页 URL 中的 remote projectId。
- `prompt`：Seedance 最终提示词，不能为空。
- `count`：1–20，默认 1。
- `replaceMaterials`：默认 true；true 表示最终素材和顺序完全以本清单为准。
- `settings`：可选。`mode` 为 `text-to-video`、`image-to-video`、`reference-to-video` 或 `first-last-frame`；其余值须符合当前心影模型能力。Seedance 2.5 支持 `videoFormat: "mp4" | "mov"` 和 `networkEnabled: boolean`；未填写时心影Pro默认使用 MP4 并开启联网搜索。
- `materials`：数组顺序就是 APP 的最终创作顺序。Seedance 2.5 最多 30 图 / 10 视频 / 10 音频、合计 50 项；Seedance 2.0 最多 9 图 / 3 视频 / 3 音频、合计 15 项。虚拟人像计入对应的图片或视频数量。
- `kind: file`：本地图片、视频或音频。`role` 可为 `first-frame`、`last-frame`、`character`、`scene`、`product`、`style`、`motion`、`other`。
- `containsPerson`：每个图片和视频都必须显式填写。任意画面/帧出现真人、虚拟人物或人形角色时为 `true`；确认整项素材完全无人时为 `false`。视频必须检查覆盖全片的关键帧，不能只看封面。音频不填写该字段。
- `authorizeAsPortrait`：只用于图片或视频。`containsPerson: true`、`role: character` 或本字段为 `true`，任一条件都会被 APP 强制视为需要虚拟人像授权，不能按普通本地参考提交。
- `kind: platform-portrait`：直接复用已同步到当前心影空间的虚拟人像。

同一内容不能重复加入；提示词引用必须能在最终 `preview.orderedLabels` 中找到。图片、视频、音频分别独立编号，材料数组中的不同媒体类型可以穿插。含人图片/视频审核完成并执行 `director resolve` 后，该项必须显示 `referenceId: null` 和非空 `platformPortraitId`；否则不得提交生成。多人、背脸、远景或人物不完整的素材仍必须写为 `containsPerson: true` 并原样提交心影虚拟人像审核，不能由 Codex 提前拒绝，也不能改为 `false` 绕过；只有心影实际返回失败时才停止并报告真实原因。
