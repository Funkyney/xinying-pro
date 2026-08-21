import type { PlatformViewBounds } from "../shared/contracts";

export function backgroundAutomationBounds(bounds: PlatformViewBounds): PlatformViewBounds {
  return { ...bounds, x: 1 - bounds.width };
}
