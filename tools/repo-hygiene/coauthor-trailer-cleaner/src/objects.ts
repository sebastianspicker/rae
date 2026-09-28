/** Transform raw commit bytes without changing trees, identity headers or parent order. */
export interface Target {
  name: string;
  email: string;
}
function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanMessage(message: Buffer, targets: readonly Target[]): Buffer {
  let text = message.toString("latin1");
  for (const target of targets) {
    const name = escapePattern(asciiFold(Buffer.from(target.name).toString("latin1")));
    const email = escapePattern(asciiFold(Buffer.from(target.email).toString("latin1")));
    const whitespace = "[ \\t\\n\\r\\f\\v]*";
    const pattern = new RegExp(
      `^co-authored-by:${whitespace}${name}${whitespace}<${email}>${whitespace}(?:\\r?\\n)?`,
      "gm",
    );
    const folded = asciiFold(text);
    const pieces: string[] = [];
    let offset = 0;
    for (const match of folded.matchAll(pattern)) {
      pieces.push(text.slice(offset, match.index));
      offset = match.index + match[0].length;
    }
    pieces.push(text.slice(offset));
    text = pieces.join("");
  }
  return Buffer.from(text.replace(/(?:\r?\n){3,}/g, "\n\n"), "latin1");
}

export function transformCommit(
  raw: Buffer,
  parents: ReadonlyMap<string, string>,
  targets: readonly Target[],
): { bytes: Buffer; invalidatedSignatures: number } {
  const boundary = raw.indexOf(Buffer.from("\n\n"));
  if (boundary < 0) throw new Error("Malformed commit: missing header separator");
  const originalHeaders = raw.subarray(0, boundary).toString("latin1");
  const originalMessage = raw.subarray(boundary + 2);
  const message = cleanMessage(originalMessage, targets);
  const headers = originalHeaders.replace(
    /^parent ([0-9a-f]+)$/gm,
    (_line: string, oid: string) => {
      const mapped = parents.get(oid);
      if (!mapped)
        throw new Error(
          `Missing parent ${oid}; shallow or incomplete history cannot be transformed`,
        );
      return `parent ${mapped}`;
    },
  );
  if (headers === originalHeaders && message.equals(originalMessage))
    return { bytes: raw, invalidatedSignatures: 0 };
  let invalidatedSignatures = 0;
  const unsigned = headers
    .replace(/^(?:gpgsig(?:-sha256)?|mergetag) [^\n]*(?:\n [^\n]*)*(?:\n|$)/gm, () => {
      invalidatedSignatures++;
      return "";
    })
    .replace(/\n$/, "");
  return {
    bytes: Buffer.concat([Buffer.from(`${unsigned}\n\n`, "latin1"), message]),
    invalidatedSignatures,
  };
}
