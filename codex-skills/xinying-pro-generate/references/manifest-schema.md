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
    "modelName": "Seedance 2.0 全能参考",
    "mode": "reference-to-video",
    "aspectRatio": "16:9",
    "duration": 8,
    "resolution": "1080p",
    "audioEnabled": true
  },
  "materials": [
    {
      "kind": "file",
      "path": "C:\\shots\\07\\actor.png",
      "role": "character",
      "authorizeAsPortrait": true
    },
    {
      "kind": "file",
      "path": "C:\\shots\\07\\dialogue.wav",
      "role": "other"
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
- `settings`：可选。`mode` 为 `text-to-video`、`image-to-video`、`reference-to-video` 或 `first-last-frame`；其余值须符合当前心影模型能力。
- `materials`：数组顺序就是 APP 的最终创作顺序。Seedance 2.5 最多 30 图 / 10 视频 / 10 音频、合计 50 项；Seedance 2.0 最多 9 图 / 3 视频 / 3 音频、合计 15 项。虚拟人像计入对应的图片或视频数量。
- `kind: file`：本地图片、视频或音频。`role` 可为 `first-frame`、`last-frame`、`character`、`scene`、`product`、`style`、`motion`、`other`。
- `authorizeAsPortrait`：只用于图片或视频；清晰、可识别且会出现在成片中的人物必须为 true，先完成虚拟人像授权才允许生成。`role: character` 在 APP 中也会被强制视为需要授权，不能按普通本地参考提交。
- `kind: platform-portrait`：直接复用已同步到当前心影空间的虚拟人像。

同一内容不能重复加入；提示词引用必须能在最终 `preview.orderedLabels` 中找到。图片、视频、音频分别独立编号，材料数组中的不同媒体类型可以穿插。人物审核完成并执行 `director resolve` 后，该项必须显示 `referenceId: null` 和非空 `platformPortraitId`；否则不得提交生成。
