import { expect, test } from "bun:test";

import { filesApiUrl } from "./useFiles";

test("filesApiUrl requests selected project hydration", () => {
  expect(filesApiUrl()).toBe("/api/files");
  expect(filesApiUrl(null)).toBe("/api/files");
  expect(filesApiUrl("stikon-dispatcher")).toBe("/api/files?project=stikon-dispatcher");
  expect(filesApiUrl("space project")).toBe("/api/files?project=space%20project");
});
