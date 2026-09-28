/** Validate bounded, inert SVGs and the public PNG's structure and compressed data. */
import { inflateSync } from "node:zlib";
import { SaxesParser } from "saxes";

const maximumBytes = 1_000_000;
const forbiddenElements = new Set([
  "embed",
  "foreignobject",
  "iframe",
  "image",
  "object",
  "script",
]);
export interface SvgStructure {
  names: Set<string>;
  viewBox: string;
}
function externalStyle(value: string): boolean {
  const normalized = value.toLowerCase();
  const urls = [...normalized.matchAll(/url\s*\(([^)]*)\)/g)];
  return (
    urls.length !== [...normalized.matchAll(/url\s*\(/g)].length ||
    normalized.includes("@import") ||
    normalized.includes("javascript:") ||
    urls.some(
      (match) =>
        !match[1]
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim()
          .startsWith("#"),
    )
  );
}
export function validateSafeSvg(source: string, relative: string): SvgStructure {
  if (Buffer.byteLength(source) > maximumBytes || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error(`${relative} contains unsafe or unexpectedly large XML`);
  const parser = new SaxesParser({ xmlns: true, fileName: relative });
  const names = new Set<string>();
  let viewBox = "",
    first = true;
  parser.on("doctype", () => {
    throw new Error(`${relative} contains unsafe XML declarations`);
  });
  parser.on("opentag", (tag) => {
    const name = tag.local.toLowerCase();
    if (first) {
      if (name !== "svg") throw new Error(`${relative} is not an SVG document`);
      viewBox = tag.attributes.viewBox?.value ?? "";
      first = false;
    }
    names.add(name);
    if (forbiddenElements.has(name))
      throw new Error(`${relative} contains active or embedded SVG content`);
    for (const attribute of Object.values(tag.attributes)) {
      const local = attribute.local.toLowerCase(),
        value = attribute.value;
      if (local.startsWith("on")) throw new Error(`${relative} contains an SVG event handler`);
      if (["href", "src"].includes(local) && value && !value.startsWith("#"))
        throw new Error(`${relative} contains an external SVG reference`);
      if (externalStyle(value))
        throw new Error(`${relative} contains an external SVG style reference`);
    }
  });
  const inspectText = (value: string): void => {
    if (externalStyle(value))
      throw new Error(`${relative} contains an external SVG style reference`);
  };
  parser.on("text", inspectText);
  parser.on("cdata", inspectText);
  parser.write(source).close();
  return { names, viewBox };
}
export function validateBrandSvg(source: string, relative: string): void {
  const structure = validateSafeSvg(source, relative);
  if (!structure.names.has("title") || !structure.names.has("desc"))
    throw new Error(`${relative} requires SVG title and description elements`);
  if (!structure.viewBox) throw new Error(`${relative} requires an SVG viewBox`);
}
export function validateTerminalSvg(source: string, relative: string): void {
  validateSafeSvg(source, relative);
  if (!source.includes("Deterministic terminal capture"))
    throw new Error(`${relative} is not a generated RAE terminal capture`);
  if (source.includes("/Users/") || source.includes("C:\\Users\\"))
    throw new Error(`${relative} contains a private workstation path`);
}
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function validateSocialPreviewPng(data: Buffer, relative: string): void {
  if (data.length > maximumBytes) throw new Error(`${relative} must be smaller than 1 MB`);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error(`${relative} is not a valid PNG header`);
  const chunks: { type: string; payload: Buffer }[] = [];
  for (let offset = 8; offset < data.length; ) {
    if (data.length - offset < 12) throw new Error(`${relative} contains a truncated PNG chunk`);
    const length = data.readUInt32BE(offset),
      payloadEnd = offset + 8 + length,
      end = payloadEnd + 4;
    if (end > data.length) throw new Error(`${relative} contains a truncated PNG chunk`);
    if (crc32(data.subarray(offset + 4, payloadEnd)) !== data.readUInt32BE(payloadEnd))
      throw new Error(`${relative} contains an invalid PNG chunk CRC`);
    chunks.push({
      type: data.toString("ascii", offset + 4, offset + 8),
      payload: data.subarray(offset + 8, payloadEnd),
    });
    offset = end;
  }
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.payload.length !== 13)
    throw new Error(`${relative} is missing a valid PNG IHDR chunk`);
  if (chunks.slice(1).some((chunk) => chunk.type === "IHDR"))
    throw new Error(`${relative} contains duplicate PNG IHDR chunks`);
  const width = header.payload.readUInt32BE(0),
    height = header.payload.readUInt32BE(4);
  if (width !== 1280 || height !== 640)
    throw new Error(`${relative} must be 1280x640px, got ${width}x${height}px`);
  const compressed = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.payload),
  );
  if (!compressed.length) throw new Error(`${relative} is missing PNG image data`);
  try {
    if (!inflateSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }).length)
      throw new Error("Empty image");
  } catch (error) {
    throw new Error(`${relative} contains invalid or oversized PNG image data`, { cause: error });
  }
  if (chunks.slice(0, -1).some((chunk) => chunk.type === "IEND"))
    throw new Error(`${relative} contains a non-terminal PNG IEND chunk`);
  if (chunks.at(-1)?.type !== "IEND" || chunks.at(-1)?.payload.length !== 0)
    throw new Error(`${relative} is missing a terminal PNG IEND chunk`);
}
