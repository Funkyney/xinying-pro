// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDragMultiSelect, withSelectionState } from "../src/renderer/use-drag-multi-select";

const cardIds = ["one", "two", "three"];

function DragHarness({ initial = [] }: { initial?: string[] }) {
  const [selected, setSelected] = useState(() => new Set(initial));
  const [opened, setOpened] = useState(0);
  const drag = useDragMultiSelect({
    isSelected: (id) => selected.has(id),
    setSelected: (id, value) => setSelected((current) => withSelectionState(current, id, value)),
  });
  return createElement("div", { "data-testid": "grid", ...drag.dragProps },
    ...cardIds.map((id) => createElement("article", {
      key: id,
      "data-drag-select-id": id,
      "data-selected": selected.has(id) ? "true" : "false",
      onClick: () => { if (!drag.consumeSuppressedClick()) setOpened((count) => count + 1); },
    }, id)),
    createElement("output", { "data-testid": "opened" }, String(opened)),
  );
}

function dispatchPointer(target: Element, type: string, clientX: number, clientY = 20) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
  });
  target.dispatchEvent(event);
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((clientX: number) => host.querySelector(`[data-drag-select-id="${clientX < 50 ? "one" : clientX < 100 ? "two" : "three"}"]`)),
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("drag multi-selection", () => {
  it("adds every brushed card without mutating the previous selection", () => {
    const original = new Set(["one"]);
    const afterTwo = withSelectionState(original, "two", true);
    const afterThree = withSelectionState(afterTwo, "three", true);

    expect([...original]).toEqual(["one"]);
    expect([...afterThree]).toEqual(["one", "two", "three"]);
  });

  it("can brush across selected cards to remove them", () => {
    const original = new Set(["one", "two", "three"]);
    const afterOne = withSelectionState(original, "one", false);
    const afterTwo = withSelectionState(afterOne, "two", false);

    expect([...afterTwo]).toEqual(["three"]);
  });

  it("reuses the current set when the requested state is already applied", () => {
    const selected = new Set(["one"]);
    expect(withSelectionState(selected, "one", true)).toBe(selected);
    expect(withSelectionState(selected, "two", false)).toBe(selected);
  });

  it("selects every card crossed by a left-button drag and suppresses the preview click", () => {
    act(() => root.render(createElement(DragHarness)));
    const grid = host.querySelector<HTMLElement>("[data-testid='grid']")!;
    const first = host.querySelector<HTMLElement>("[data-drag-select-id='one']")!;

    act(() => {
      dispatchPointer(first, "pointerdown", 10);
      dispatchPointer(grid, "pointermove", 135);
      dispatchPointer(grid, "pointerup", 135);
      first.click();
    });

    expect(cardIds.map((id) => host.querySelector(`[data-drag-select-id='${id}']`)?.getAttribute("data-selected"))).toEqual(["true", "true", "true"]);
    expect(host.querySelector("[data-testid='opened']")?.textContent).toBe("0");
  });

  it("does not capture an ordinary click before the pointer becomes a drag", () => {
    act(() => root.render(createElement(DragHarness)));
    const first = host.querySelector<HTMLElement>("[data-drag-select-id='one']")!;

    act(() => {
      dispatchPointer(first, "pointerdown", 10);
      dispatchPointer(first, "pointerup", 10);
      first.click();
    });

    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='opened']")?.textContent).toBe("1");
  });

  it("deselects every crossed card when the drag begins on a selected card", () => {
    act(() => root.render(createElement(DragHarness, { initial: cardIds })));
    const grid = host.querySelector<HTMLElement>("[data-testid='grid']")!;
    const first = host.querySelector<HTMLElement>("[data-drag-select-id='one']")!;

    act(() => {
      dispatchPointer(first, "pointerdown", 10);
      dispatchPointer(grid, "pointermove", 135);
      dispatchPointer(grid, "pointerup", 135);
    });

    expect(cardIds.map((id) => host.querySelector(`[data-drag-select-id='${id}']`)?.getAttribute("data-selected"))).toEqual(["false", "false", "false"]);
  });
});
