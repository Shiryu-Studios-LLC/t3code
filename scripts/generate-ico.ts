import * as fs from "node:fs";
import { encodePngIco, type PngIconImage, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

// Load 16, 24, 32, 48, 64, 128, 256 sizes from generated files or create them
const sizes = [16, 32, 48, 64, 128, 256];
const images: PngIconImage[] = [];

// For now read the 1024 / 32 / 16 PNGs
const png1024 = fs.readFileSync("assets/dev/blueprint-macos-1024.png");
const png32 = fs.readFileSync("assets/dev/blueprint-web-favicon-32x32.png");
const png16 = fs.readFileSync("assets/dev/blueprint-web-favicon-16x16.png");

images.push({ size: 16, contents: png16 });
images.push({ size: 32, contents: png32 });

const icoBuffer = encodePngIco(images);

fs.writeFileSync("assets/dev/blueprint-windows.ico", icoBuffer);
fs.writeFileSync("assets/dev/blueprint-web-favicon.ico", icoBuffer);
fs.writeFileSync("assets/prod/t3-black-windows.ico", icoBuffer);
fs.writeFileSync("assets/prod/t3-black-web-favicon.ico", icoBuffer);
fs.writeFileSync("apps/web/public/favicon.ico", icoBuffer);

console.log("ICO files successfully generated.");
