import { Children, isValidElement } from "react";
import { describe, expect, test } from "bun:test";

import { md } from "./markdown";

describe("feed markdown links", () => {
  test("renders local markdown links as viewer deep links", () => {
    const nodes = Children.toArray(md("see [markdown.tsx](/home/latand/app/src/components/feed/markdown.tsx:57)"));
    const link = nodes.find((node) => isValidElement(node) && node.props.href);

    expect(isValidElement(link)).toBe(true);
    expect(link.props.href).toBe("#f=%2Fhome%2Flatand%2Fapp%2Fsrc%2Fcomponents%2Ffeed%2Fmarkdown.tsx");
    expect(link.props.label).toBe("markdown.tsx");
  });

  test("keeps external markdown links clickable", () => {
    const nodes = Children.toArray(md("[docs](https://example.com/docs)"));
    const link = nodes.find((node) => isValidElement(node) && node.props.href);

    expect(isValidElement(link)).toBe(true);
    expect(link.props.href).toBe("https://example.com/docs");
    expect(link.props.label).toBe("docs");
  });
});
