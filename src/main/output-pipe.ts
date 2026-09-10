type OutputStream = {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
};

/**
 * Packaged GUI applications can inherit stdout/stderr from a short-lived
 * launcher (for example the updater). Once that launcher exits, a later
 * console write emits EPIPE/EOF on the stream. Without an error listener Node
 * treats it as an uncaught main-process exception and Electron shows a crash
 * dialog, even though the application itself is healthy.
 */
export function guardClosedOutputPipe(stream: OutputStream | undefined): void {
  stream?.on("error", () => undefined);
}

