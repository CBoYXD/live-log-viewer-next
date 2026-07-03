export function compactPath(value: string): string {
  return value.replace(/(?:\/[^\s)]+){3,}/g, (match) => {
    if (match.length <= 40) return match;
    const parts = match.split("/").filter(Boolean);
    return parts.length >= 2 ? ".../" + parts.slice(-2).join("/") : match;
  });
}

export function cleanTitle(value: string, maxLength = 160): string {
  const stripped = value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const compacted = compactPath(stripped).replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? compacted.slice(0, maxLength - 1).trimEnd() + "…" : compacted;
}

export function shortTitle(value: string, maxLength = 32): string {
  const cleaned = cleanTitle(value, maxLength + 20);
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 1).trimEnd() + "…" : cleaned;
}
