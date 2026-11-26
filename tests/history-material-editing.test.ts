import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaywrightXinyingAdapter } from "../src/main/playwright-adapter";
import * as composer from "../src/main/history-composer";
import * as localUpload from "../src/main/local-file-upload";
import { parseConversationHistory } from "../src/shared/conversation-history";
import { historyMaterialOrder, resolveHistoryMaterials, updateHistoryMaterialSelection } from "../src/shared/history-material-order";
import type { Job, ReferenceAsset } from "../src/shared/contracts";

const params = { text: "@图1 @图2 @图3", model_name: "Seedance 2.5 全能参考", duration: 10, aspect: "9:16", resolution: "1080p",
  image: [0, 1, 2].map((i) => ({ material_id: `cloud-${i}`, material_name: `云端 ${i}`, cdn_url: `https://example.com/${i}.png` })) };
const payload = { code: 0, data: { project_id: "remote", avp_session_id: "session", grouped_records: [{ event_id: 123, task_create_parmas: params }] } };
const source = () => parseConversationHistory(payload, "remote", "session").entries[0].source;
const reference = { id: "new", projectId: "local", name: "新图", mimeType: "image/png", role: "other", filePath: "new.png" } as ReferenceAsset;
const job = (): Job => ({ promptSnapshot: "@图1 @图2 @图3", references: [reference], parameters: { platformUrl: "https://blueaivideo.com/agentlab?projectId=remote&sessionId=session", mode: "reference-to-video", platformPortraits: [] } } as unknown as Job);

describe("editable history material preparation", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(localUpload, "setLocalInputFiles").mockResolvedValue(); });
  it("replaces at the requested position, re-adds removed files, and never duplicates an existing selection", () => {
    expect(updateHistoryMaterialSelection(["a", "b", "c"], ["c"], "a")).toEqual(["c", "b"]);
    expect(updateHistoryMaterialSelection(["a", "b"], ["a", "c"])).toEqual(["a", "b", "c"]);
    expect(updateHistoryMaterialSelection(["a", "b"], ["b"], "b")).toEqual(["a", "b"]);
    expect(updateHistoryMaterialSelection(["a"], ["c"])).toEqual(["a", "c"]);
  });
  it("never imports unrelated local materials; resolves explicit cloud/local selections in one numbered order", () => {
    expect(historyMaterialOrder(source())).toEqual(["history:image:0", "history:image:1", "history:image:2"]);
    expect(resolveHistoryMaterials(source(), [reference], []).every((item) => item.cloud)).toBe(true);
    const selected = resolveHistoryMaterials({ ...source(), materialOrder: ["history:image:2", "reference:new", "history:image:0"] }, [reference], []);
    expect(selected.map((item) => [item.name, item.label])).toEqual([["云端 2", "@图1"], ["新图", "@图2"], ["云端 0", "@图3"]]);
    expect(resolveHistoryMaterials({ ...source(), materialOrder: [] }, [reference], [])).toEqual([]);
  });
  it("reuses retained cloud objects, uploads only new files, and writes the exact edited order without submitting", async () => {
    let state = composer.emptyHistoryMaterials();
    const bridge = vi.spyOn(composer, "historyComposerMaterials").mockImplementation(async (_page, requested) => {
      if (requested) state = structuredClone(requested);
      return structuredClone(state);
    });
    // Official DOM cards become visible before the cloud metadata is committed.
    const input = { count: vi.fn().mockResolvedValue(1), getAttribute: vi.fn().mockResolvedValue(""), setInputFiles: vi.fn() };
    const page = { url: () => "https://blueaivideo.com/agentlab?projectId=remote&sessionId=session", goto: vi.fn(), click: vi.fn(),
      waitForTimeout: vi.fn(async () => { state.image.push({ material_id: "uploaded", cdn_url: "https://example.com/upload.png" }); }) };
    const adapter: any = Object.assign(Object.create(PlaywrightXinyingAdapter.prototype), { authenticatedGet: vi.fn().mockResolvedValue(payload), referenceUploadInput: vi.fn().mockResolvedValue(input), waitForMaterialCount: vi.fn().mockResolvedValue(true) });
    const result = await adapter.restoreConversationHistory(page, job(), { ...source(), materialOrder: ["history:image:2", "reference:new", "history:image:0"] });
    expect(result.promptForPlatform).toBe("@图1 @图2 @图3");
    expect(state.image.map((item) => item.material_id)).toEqual(["cloud-2", "uploaded", "cloud-0"]);
    expect(state.image[0]).toMatchObject(params.image[2]);
    expect(state.image[0]).not.toHaveProperty("_uid");
    expect(params.image[2]).not.toHaveProperty("_uid");
    expect(localUpload.setLocalInputFiles).toHaveBeenCalledExactlyOnceWith(page, input, ["new.png"]);
    expect(input.setInputFiles).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled(); expect(page.click).not.toHaveBeenCalled();
    expect(page.waitForTimeout).toHaveBeenCalledExactlyOnceWith(200);
    expect(bridge).toHaveBeenCalledTimes(5);
  });
  it("stops for missing selections, changed source, or an upload rejected by the official page", async () => {
    const bridge = vi.spyOn(composer, "historyComposerMaterials").mockResolvedValue(composer.emptyHistoryMaterials());
    const input = { count: vi.fn().mockResolvedValue(1), getAttribute: vi.fn().mockResolvedValue(null), setInputFiles: vi.fn() };
    const page = { url: () => "https://blueaivideo.com/agentlab?projectId=remote&sessionId=session" };
    const adapter: any = Object.assign(Object.create(PlaywrightXinyingAdapter.prototype), { authenticatedGet: vi.fn().mockResolvedValue(payload), referenceUploadInput: vi.fn().mockResolvedValue(input), waitForMaterialCount: vi.fn().mockResolvedValue(false) });
    expect(await adapter.restoreConversationHistory(page, job(), { ...source(), prompt: "changed" })).toMatchObject({ reason: "page-changed" });
    expect(await adapter.restoreConversationHistory(page, job(), { ...source(), materialOrder: ["reference:missing"] })).toMatchObject({ reason: "page-changed" });
    expect(bridge).not.toHaveBeenCalled();
    expect(await adapter.restoreConversationHistory(page, job(), { ...source(), materialOrder: ["reference:new"] })).toMatchObject({ reason: "approval" });
  });
});
