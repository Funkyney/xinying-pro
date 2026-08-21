import fs from "node:fs";
import path from "node:path";

const DEFAULT_AUTOMATION_PORT = 9333;
const ALTERNATE_AUTOMATION_PORT = 9334;
const PORT_MARKER_NAME = "automation-port";

function validPort(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export function readAutomationPort(dataDir: string): number | null {
  try {
    return validPort(fs.readFileSync(path.join(dataDir, PORT_MARKER_NAME), "utf8").trim());
  } catch {
    return null;
  }
}

/**
 * Alternating the packaged app's localhost CDP port prevents a just-installed
 * process from racing the previous Electron process while it is still exiting.
 */
export function reserveAutomationPort(dataDir: string, explicitPort?: string, preferAlternateOnMissing = false): number {
  const explicit = validPort(explicitPort);
  if (explicit !== null) return explicit;

  const previous = readAutomationPort(dataDir);
  const port = previous === DEFAULT_AUTOMATION_PORT
    ? ALTERNATE_AUTOMATION_PORT
    : previous === ALTERNATE_AUTOMATION_PORT
      ? DEFAULT_AUTOMATION_PORT
      : preferAlternateOnMissing
        ? ALTERNATE_AUTOMATION_PORT
        : DEFAULT_AUTOMATION_PORT;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, PORT_MARKER_NAME), String(port), "utf8");
  return port;
}

export function automationPortCandidates(dataDir: string, explicitPort?: string): number[] {
  const explicit = validPort(explicitPort);
  if (explicit !== null) return [explicit];
  return [...new Set([readAutomationPort(dataDir), DEFAULT_AUTOMATION_PORT, ALTERNATE_AUTOMATION_PORT]
    .filter((port): port is number => port !== null))];
}
