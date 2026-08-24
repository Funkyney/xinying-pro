export class InteractionGate {
  private active = false;

  tryEnter(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  leave(): void {
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }
}

export function userFacingError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "")
    .trim() || "操作未完成，请稍后重试";
}
