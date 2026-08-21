import fs from "node:fs";
import path from "node:path";
import png2icons from "png2icons";

const root = process.cwd();
const source = path.join(root, "build", "icon-mac.png");
const input = fs.readFileSync(source);
const icns = png2icons.createICNS(input, png2icons.BICUBIC2, 0);
const ico = png2icons.createICO(input, png2icons.BICUBIC2, 0, false, true);
if (!icns || !ico) throw new Error("无法从品牌 PNG 生成 ICNS/ICO 图标");
const icnsPath = path.join(root, "build", "icon.icns");
const icoPath = path.join(root, "build", "icon.ico");
fs.writeFileSync(icnsPath, icns);
fs.writeFileSync(icoPath, ico);
process.stdout.write(`${JSON.stringify({ ok: true, source, outputs: [icnsPath, icoPath] })}\n`);
