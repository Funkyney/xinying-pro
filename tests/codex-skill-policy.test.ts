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

  it("does not monitor or download results unless separately requested", () => {
    expect(source).toContain("不要默认运行 `job events`、`results sync`、`results list` 或下载命令");
    expect(source).toContain("另行明确要求“继续监控 / 查结果 / 下载”");
  });

  it("never submits a recognizable person as an ordinary local reference", () => {
    expect(source).toContain("人物硬门禁");
    expect(source).toContain("每个图片和视频文件都必须在清单中显式填写 `containsPerson`");
    expect(source).toContain("视频检查首帧、尾帧以及覆盖全片的关键帧");
    expect(source).toContain("含人图片或视频仍出现在最终 `preview.references`：停止提交");
    expect(source).toContain("绝不按普通图片或普通视频兜底");
  });

  it("lets Heart review multi-person and imperfect portrait assets instead of pre-rejecting them", () => {
    expect(source).toContain("不要在 Codex 侧预判审核失败");
    expect(source).toContain("通过 `director authorize` 原样提交心影虚拟人像审核");
    expect(source).toContain("只有心影表单、接口或审核任务明确返回失败后才暂停");
    expect(source).not.toContain("暂停并请用户提供可审核的单人素材");
  });

  it("resumes recoverable default portrait metadata failures without sending the user to the web page", () => {
    expect(source).toContain("性别/年龄/人种选项不可用：其他");
    expect(source).toContain("`job resume <job-id> --confirm`");
    expect(source).toContain("同一任务在本次流程最多自动恢复 2 次");
    expect(source).toContain("不要让用户手工进网页");
  });
});
