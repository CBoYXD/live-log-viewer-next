"use client";

import { useRef } from "react";

import { type FlipEnter, useFlip } from "@/hooks/useFlip";

/**
 * List container with FLIP animations: direct children must carry
 * `data-flip-key`; reorders glide, new entries fade in (`enter` picks the
 * entrance style — noisy lists want the quiet "fade").
 */
export function FlipRow({
  className,
  style,
  enter = "scale",
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  enter?: FlipEnter;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFlip(ref, enter);
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
