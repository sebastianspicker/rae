const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function extractNormalizedHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+)/)?.[1];
    if (heading) headings.add(normalize(heading.trim()));
  }
  return headings;
}
