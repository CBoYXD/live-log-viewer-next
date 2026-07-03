"use client";

import { useEffect, useState } from "react";

const STEPS: Array<[number, number]> = [
  [1920, 4],
  [1440, 3],
  [1024, 2],
];

function measure(): number {
  if (typeof window === "undefined") return 3;
  for (const [minWidth, cols] of STEPS) {
    if (window.innerWidth >= minWidth) return cols;
  }
  return 1;
}

/** Pane columns per dashboard page: 4 at ≥1920px, 3 at ≥1440, 2 at ≥1024, else 1. */
export function useColumns(): number {
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const onResize = () => setCols(measure());
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cols;
}
