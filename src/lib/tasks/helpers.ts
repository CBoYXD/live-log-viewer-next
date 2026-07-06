export function isoNow(): string {
  return new Date().toISOString();
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export function firstLineTitle(text: string): string {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first || "Untitled";
}

export function taskDeliveryText(id: string, text: string): string {
  return `Task #${shortTaskId(id)}: ${text}`;
}
