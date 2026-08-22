import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.XINYING_DATA_DIR) return path.resolve(process.env.XINYING_DATA_DIR);

  const roaming = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "xinying-director");
}

export interface AppPaths {
  dataDir: string;
  databasePath: string;
  assetsDir: string;
  sharedMediaDir: string;
  portraitsDir: string;
  jobSnapshotsDir: string;
  outputsDir: string;
  browserProfileDir: string;
  logsDir: string;
}

export function createAppPaths(explicit?: string): AppPaths {
  const dataDir = resolveDataDir(explicit);
  const paths: AppPaths = {
    dataDir,
    databasePath: path.join(dataDir, "xinying.sqlite3"),
    assetsDir: path.join(dataDir, "assets"),
    sharedMediaDir: path.join(dataDir, "shared-media"),
    portraitsDir: path.join(dataDir, "portraits"),
    jobSnapshotsDir: path.join(dataDir, "job-snapshots"),
    outputsDir: path.join(dataDir, "outputs"),
    browserProfileDir: path.join(dataDir, "browser-profile"),
    logsDir: path.join(dataDir, "logs"),
  };

  for (const directory of Object.values(paths).filter((value) => !path.extname(value))) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return paths;
}
