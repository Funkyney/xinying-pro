import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("codex-skills", "xinying-pro-generate", "SKILL.md"), "utf8");

describe("xinying-pro-generate completion policy", () => {
  it("treats confirmed generating jobs as the default success boundary", () => {
    expect(source).toContain("全部任务均为 `running` 或 `completed`");
    expect(source).toContain("立即结束 Codex 流程");
    expect(source).toContain("结果由用户稍后人工查看");
  });

  it("uses one compact MCP call with a CLI fallback instead of repeated polling commands", () => {
    expect(source).toContain("首选只调用一次心影Pro MCP `generate`");
    expect(source).toContain('{"manifestPath":"<absolute-manifest-path>","requestId":"<stable-id-for-this-user-request>","confirm":true}');
    expect(source).toContain("同一次用户生成指令必须始终复用相同的 `requestId`");
    expect(source).toContain("当前 Codex 会话没有心影Pro MCP 时，才执行");
    expect(source).toContain('director run --manifest "<absolute-manifest-path>" --confirm');
    expect(source).toContain("不要另开 `job status`");
    expect(source).toContain("media cache --file");
    expect(source).toContain("SHA-256");
  });

  it("does not monitor or download results unless separately requested", () => {
    expect(source).toContain("不要默认运行 `job events`、`results sync`、`results list` 或下载命令");
    expect(source).toContain("另行明确要求“继续监控 / 查结果 / 下载”");
  });

  it("never submits a recognizable person as an ordinary local reference", () => {
    expect(source).toContain("人物硬门禁");
    expect(source).toContain("结论明确时，每个图片/视频在清单中显式填写 `containsPerson`");
    expect(source).toContain("结论不稳时不要猜布尔值");
    expect(source).toContain("JEV 不读取媒体文件");
    expect(source).toContain("视频检查首帧、尾帧和覆盖全片的关键帧");
    expect(source).toContain("含人图片或视频仍出现在最终 `preview.references`：停止提交");
    expect(source).toContain("绝不按普通图片或普通视频兜底");
  });

  it("lets Heart review multi-person and imperfect portrait assets instead of pre-rejecting them", () => {
    expect(source).toContain("不要在 Codex 侧预判审核失败");
    expect(source).toContain("通过 `director authorize` 原样提交心影虚拟人像审核");
    expect(source).toContain("只有心影表单、接口或审核任务明确返回失败后才暂停");
    expect(source).not.toContain("暂停并请用户提供可审核的单人素材");
  });

  it("leaves transient portrait-form and material mapping recovery inside the app", () => {
    expect(source).toContain("全部由 APP 内部自动清理、重试、回绑和重写编号");
    expect(source).toContain("不要执行 `job resume`");
    expect(source).toContain("不要让用户删除重传、改提示词或进入网页补操作");
    expect(source).toContain("视频人像被角色槽显示为 `@图N`");
  });

  it("carries Seedance 2.5 MOV and network settings through the manifest", () => {
    expect(source).toContain('videoFormat: "mp4"');
    expect(source).toContain("networkEnabled: true");
    expect(source).toContain("高级配置");
  });
});
