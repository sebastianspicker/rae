/** Preserve Python 3.14 identity normalization with immutable Unicode 16 full case folding. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const table = readFileSync(new URL("../data/CaseFolding-16.0.0.txt", import.meta.url));
if (
  createHash("sha256").update(table).digest("hex") !==
  "6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb"
)
  throw new Error("Unicode case-folding data does not match the pinned version");
const mappings = new Map<number, string>();
for (const line of table.toString("utf8").split("\n")) {
  const match = /^([0-9A-F]+); [CF]; ([0-9A-F ]+);/.exec(line);
  if (match)
    mappings.set(
      Number.parseInt(match[1], 16),
      String.fromCodePoint(
        ...match[2]
          .trim()
          .split(" ")
          .map((code) => Number.parseInt(code, 16)),
      ),
    );
}
export function caseFold(value: string): string {
  return Array.from(
    value,
    (character) => mappings.get(character.codePointAt(0) ?? -1) ?? character,
  ).join("");
}
export const identityWhitespace =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const edges = new RegExp(`^[${identityWhitespace}]+|[${identityWhitespace}]+$`, "g");
export function trimIdentity(value: string): string {
  return value.replace(edges, "");
}
export const identityPattern = new RegExp(
  `^[${identityWhitespace}]*([^\\n]+?)[${identityWhitespace}]*<([^<>${identityWhitespace}]+@[^<>${identityWhitespace}]+)>[${identityWhitespace}]*$`,
);
export const emailPattern = new RegExp(`^[^<>${identityWhitespace}]+@[^<>${identityWhitespace}]+$`);
