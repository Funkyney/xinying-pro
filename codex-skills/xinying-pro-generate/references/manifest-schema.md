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
    "networkEnabled": true,
    "autoPortraitAudit": true,
    "promptOptimizer": false,
    "draftMode": false,
    "smartBalance": false,
    "inspiration": {}
  },
  "materials": [
    {
      "kind": "file",
      "path": "C:\\shots\\07\\actor.png",
      "containsPerson": true,
      "role": "character"
    },
    {
      "kind": "file",
      "path": "C:\\shots\\07\\dialogue.wav",
      "role": "other"
    },
    {
      "kind": "file",
      "path": "C:\\shots\\07\\empty-room.mp4",
      "personCheck": {
        "verdict": "no-person",
        "confidence": 0.9,
        "summary": "覆盖全片的关键帧只包含空房间和家具",
        "inspectedFrames": 18,
        "inspectionComplete": true
      },
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
- `autoPortraitAudit`：Seedance 2.0 / 2.5 默认 true。图片由官网自动分析、审核并辅助录入角色库，不再单独创建授权任务；提交前必须确认官网开关生效。官网注明为实验功能，请勿传入真人形象 IP；满 300 项时官网会自动删除最旧角色。含人物视频不在该功能范围内。
- `resolution` / `networkEnabled`：当前官网的 Seedance 2.0 / 2.5 均提供 `4k` 与联网搜索；联网默认开启，实际参数会逐项回读确认。
- `promptOptimizer`：官网提示词优化，默认 false，避免改变定稿提示词。
- `draftMode`：样片模式，强制 480P + MP4。官网提供 7 天内二次高清渲染，当前可在原网页操作后续渲染。
- `smartBalance`：官网“智能均衡模式”，智能调配资源降低积分消耗，可能增加生成时间。
- `inspiration`：分类到选项名称的映射，每个分类最多一项；只使用“同步官网选项”读到的当前名称，不编造枚举。
- `containsPerson`：启用官方自动图片审核时图片可省略。视频、或未启用该功能的图片，需要人物检查：任意帧有人为 true，确认整项无人为 false；不能只检查视频封面。音频不填。
- `personCheck`：仅用于已经完成视觉检查但结论仍需置信度路由的图片/视频。`verdict` 为 `person`、`no-person` 或 `uncertain`，`confidence` 为 0-1，`summary` 写可见证据，视频可写 `inspectedFrames`，完整覆盖检查时写 `inspectionComplete: true`。使用该字段时可省略 `containsPerson`；APP 会先复用文件缓存，再将全部歧义项批量交给 TypeSafe JEV。JEV 不接收原图/视频，不能凭空完成视觉识别；证据不足时仍会停止。
- `authorizeAsPortrait`：独立授权路径的图片/视频使用。开启官方自动图片审核时，图片忽略旧清单中的此字段，不重复授权；含人物视频仍强制独立授权。
- `kind: platform-portrait`：直接复用已同步到当前心影空间的虚拟人像。

同一内容不能重复加入；提示词引用必须能在最终 `preview.orderedLabels` 中找到。图片、视频、音频独立编号，可以混排。开启官方自动图片审核时，图片保留非空 `referenceId` 和 `authorizationState: not-needed`，这是正确路径，不表示已通过审核；实际由官网处理。需要独立授权的含人物视频（及关闭自动审核时的含人图片）审核完成后必须替换为非空 `platformPortraitId`。官网审核失败时停止，不能降级绕过。
