import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MigrationRibbon } from "./MigrationRibbon";

test("pending state announces via role=status with its own text (not color-only)", () => {
  const html = renderToStaticMarkup(<MigrationRibbon state="pending" targetLabel="Work" />);
  expect(html).toContain('role="status"');
  expect(html).toContain("Account switch pending");
});

test("switching names the target and marks the spinner reduced-motion safe", () => {
  const html = renderToStaticMarkup(<MigrationRibbon state="switching" targetLabel="Work" />);
  expect(html).toContain("Switching to «Work»");
  expect(html).toContain("motion-reduce:animate-none");
});

test("failed shows the error detail plus Retry and Keep actions", () => {
  const html = renderToStaticMarkup(
    <MigrationRibbon state="failed" targetLabel="Work" currentLabel="Main" error="auth expired" onRetry={() => {}} onKeep={() => {}} />,
  );
  expect(html).toContain("Account switch failed");
  expect(html).toContain("auth expired");
  expect(html).toContain("Retry");
  expect(html).toContain("Keep on «Main»");
});

test("done and rolled-back render nothing (feed divider / silent)", () => {
  expect(renderToStaticMarkup(<MigrationRibbon state="done" targetLabel="Work" />)).toBe("");
  expect(renderToStaticMarkup(<MigrationRibbon state="rolled-back" targetLabel="Work" />)).toBe("");
  expect(renderToStaticMarkup(<MigrationRibbon state={null} targetLabel="Work" />)).toBe("");
});
