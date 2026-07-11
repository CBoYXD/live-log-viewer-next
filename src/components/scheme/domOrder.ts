import type { SchemeNode } from "./layout";

/** Keep live pane hosts attached while activity changes their visual position. */
export function stableNodeDomOrder(nodes: readonly SchemeNode[]): SchemeNode[] {
  return [...nodes].sort((a, b) => a.file.path.localeCompare(b.file.path));
}
