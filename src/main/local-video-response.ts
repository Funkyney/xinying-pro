import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";

// Chromium's custom-scheme video player needs both a byte length and range
// responses to seek before the whole file is buffered.
export async function localVideoResponse(file: string, type: string, request: Request): Promise<Response> {
  const { size } = await fs.stat(file);
  const headers = new Headers({ "Content-Type": type, "Accept-Ranges": "bytes" });
  const range = request.headers.get("range");
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (match && match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match && match[2]) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      headers.set("Content-Range", "bytes */" + size);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  const body = size && request.method !== "HEAD"
    ? Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
    : null;
  return new Response(body, { status: range ? 206 : 200, headers });
}
