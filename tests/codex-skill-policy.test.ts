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
});
