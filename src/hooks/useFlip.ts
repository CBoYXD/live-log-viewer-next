import { type RefObject, useLayoutEffect, useRef } from "react";

const MOVE_MS = 280;

export type FlipEnter = "scale" | "fade" | "none";

function reducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * FLIP animations for a list container: direct children carrying
 * `data-flip-key` glide to their new spots, new children fade in. Built on
 * WAAPI (el.animate), which keeps three invariants the transition approach
 * broke: an interrupted move restarts from its CURRENT visual position
 * (visual rect before cancel minus natural rect after), stale timers can't
 * kill a newer animation, and the style attribute stays untouched so CSS
 * transitions (ring highlights) keep working. Positions are measured every
 * pass relative to the container (scroll-compensated), so late layout
 * shifts animate too and panning never fakes a move. `data-flip-skip`
 * exempts the child being dragged.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, enter: FlipEnter = "scale") {
  const prevRects = useRef(new Map<string, { x: number; y: number }>());
  const anims = useRef(new WeakMap<HTMLElement, Animation>());
  const firstPass = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = reducedMotion();
    const base = el.getBoundingClientRect();
    const children = [...el.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.flipKey !== undefined,
    );
    const next = new Map<string, { x: number; y: number }>();
    for (const child of children) {
      const key = child.dataset.flipKey!;
      const visual = child.getBoundingClientRect();
      const running = anims.current.get(child);
      if (running) {
        running.cancel();
        anims.current.delete(child);
      }
      const settled = child.getBoundingClientRect();
      const natural = { x: settled.left - base.left + el.scrollLeft, y: settled.top - base.top + el.scrollTop };
      const prev = prevRects.current.get(key);
      next.set(key, natural);
      if (reduced || firstPass.current || child.dataset.flipSkip !== undefined) continue;
      if (!prev) {
        if (enter === "none") continue;
        const frames =
          enter === "fade"
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: "scale(0.96)" },
                { opacity: 1, transform: "scale(1)" },
              ];
        const anim = child.animate(frames, { duration: enter === "fade" ? 120 : 240, easing: "ease-out" });
        anims.current.set(child, anim);
        anim.addEventListener("finish", () => anims.current.delete(child));
        continue;
      }
      const dx = prev.x - natural.x + (visual.left - settled.left);
      const dy = prev.y - natural.y + (visual.top - settled.top);
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      const anim = child.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
        { duration: MOVE_MS, easing: "cubic-bezier(0.22, 0.72, 0.3, 1)" },
      );
      anims.current.set(child, anim);
      anim.addEventListener("finish", () => anims.current.delete(child));
    }
    prevRects.current = next;
    firstPass.current = false;
  });
}
