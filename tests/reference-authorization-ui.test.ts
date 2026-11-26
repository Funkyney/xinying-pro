// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReferenceBoard } from "../src/renderer/components/ReferenceBoard";
import type { ReferenceAsset, XinyingApi } from "../src/shared/contracts";

it("keeps video manual authorization while images use the official automatic audit", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.xinying = { references: { mediaUrl: (file: string) => file } } as XinyingApi;
  const host = document.createElement("div"), root = createRoot(host), authorize = vi.fn();
  document.body.append(host);
  const assets = ["image/png", "video/mp4", "audio/wav"].map((mimeType, index) => ({ id: String(index), name: String(index), filePath: `/fixture/${index}`, mimeType, role: "other", position: index }) as ReferenceAsset);
  try {
    act(() => root.render(createElement(ReferenceBoard, { assets, portraits: [], materialOrder: assets.map(asset => `reference:${asset.id}`), nativeImageAudit: true,
      onAdd: vi.fn(), onBatchReplace: vi.fn(), onReorder: vi.fn(), onRole: vi.fn(), onReplace: vi.fn(), onAuthorize: authorize, onRemove: vi.fn(), onRemovePortrait: vi.fn(), authorizationStates: {} })));
    const buttons = host.querySelectorAll<HTMLButtonElement>(".authorize-reference-button");
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].textContent).toContain("官方自动审核");
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[1].textContent).toBe("授权为虚拟人像");
    act(() => buttons[1].click());
    expect(authorize).toHaveBeenCalledExactlyOnceWith(assets[1]);
    expect(buttons[2].disabled).toBe(true);
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
