import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizedClipMarkers } from "../shared/result-annotations";

const execute = promisify(execFile);

export async function exportMarkedClip(source: string, destination: string, times: readonly number[]): Promise<void> {
  const extension = path.extname(destination).toLowerCase();
  if (![".mov", ".mp4"].includes(extension)) throw new Error("带剪辑标记的视频请保存为原片的 MP4 或 MOV 格式");
  if (path.extname(source).toLowerCase() !== extension) throw new Error("打点导出不转码，请保持原片的 MP4 或 MOV 扩展名");
  if (times.some(time => !Number.isSafeInteger(time) || time < 0)) throw new Error("无效的剪辑标记时间");
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) {
    throw new Error("请选择新的导出位置，以保留结果库原片");
  }
  // Edit a private copy on the destination volume. Publish it only after all
  // markers have been written, even when replacing a previous export.
  const directory = await fs.mkdtemp(path.join(path.dirname(destination), ".xinying-markers-"));
  const filename = "clip" + extension;
  const staged = path.join(directory, filename);
  try {
    await fs.copyFile(source, staged);
    const markers = normalizedClipMarkers(times).map((time, i) =>
      `{StartTime=${time},Duration=0,Name=镜头 ${i + 1},Type=Comment}`);
    // Adobe Dynamic Media track times are frames at the track's declared
    // frame rate. f1000 represents the source playback time in milliseconds.
    const track = `{TrackName=Comment,TrackType=Comment,FrameRate=f1000,Markers=[${markers.join(",")}]}`;
    const args = ["-overwrite_original", "-XMP-xmpDM:Tracks+=" + track, filename];
    await fs.writeFile(path.join(directory, "markers.args"), args.join("\n") + "\n", "utf8");
    const executable: string = process.platform === "win32" ? require("exiftool-vendored.exe") : require("exiftool-vendored.pl");
    const binary = executable.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    const { stdout } = await execute(binary, ["-config", "", "-@", "markers.args"], {
      cwd: directory, windowsHide: true, timeout: 180_000,
    });
    if (!/1 image files? updated/.test(stdout)) throw new Error("元数据工具未确认写入");
    await fs.rename(staged, destination);
  } catch (error) {
    throw new Error("剪辑标记导出失败：" + (error instanceof Error ? error.message : String(error)));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
