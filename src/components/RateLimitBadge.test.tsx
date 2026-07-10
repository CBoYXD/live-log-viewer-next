import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RateLimitBadge } from "./RateLimitBadge";

test("rate-limit badge carries the reset time", () => {
  const html = renderToStaticMarkup(
    <RateLimitBadge
      rateLimit={{ source: "account", accountId: "main", window: "session", resetAt: 1_800_003_300 }}
    />,
  );

  expect(html).toContain("data-rate-limited");
  expect(html).toContain("rate-limited until");
});
