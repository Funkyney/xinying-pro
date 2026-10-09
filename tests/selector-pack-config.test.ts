import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Heart selector pack", () => {
  it("reveals the lazy-mounted local upload controls introduced by the current composer", () => {
    const selectorPath = path.join(process.cwd(), "config", "xinying-selectors.json");
    const pack = JSON.parse(fs.readFileSync(selectorPath, "utf8")) as {
      version: number;
      generation: Record<string, string[]>;
      portrait: { dialog: string[]; uploadInput: string[] };
    };

    expect(pack.version).toBeGreaterThanOrEqual(7);
    expect(pack.generation.imageUploadTrigger.join(" ")).toContain("图片");
    expect(pack.generation.videoUploadTrigger.join(" ")).toContain("视频");
    expect(pack.generation.audioUploadTrigger.join(" ")).toContain("音频");
    expect(pack.generation.imageUploadTrigger.join(" ")).toContain("aria-haspopup='menu'");
    expect(pack.portrait.dialog).toContain(".PDialog.createCharacter");
    expect(pack.portrait.uploadInput.join(" ")).toContain(".mp4");
    expect(pack.generation.advancedPopover).toContain(".ContentConfigPopover");
    expect(pack.generation.advancedRows).toEqual(expect.arrayContaining([".config-row", ".adv-row"]));
    expect(pack.generation.portraitDialog).toContain(".Dialog4StudioSetting:has(.facesList)");
    expect(pack.generation.portraitCheckbox).toEqual(expect.arrayContaining([
      ".p-checkbox-black",
      ".selection-checkbox .p-checkbox",
    ]));
  });
});
