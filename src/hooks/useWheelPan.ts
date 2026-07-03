import { type RefObject, useEffect } from "react";

/**
 * Vertical wheel pans a horizontal scroller, unless the pointer sits over an
 * element that scrolls vertically itself (feed, deep graph) — that one keeps
 * native wheel behavior.
 */
export function useWheelPan(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY || event.deltaX || event.shiftKey || event.ctrlKey) return;
      for (let node = event.target as HTMLElement | null; node && node !== el; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const overflowY = getComputedStyle(node).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") return;
        }
      }
      if (el.scrollHeight > el.clientHeight + 1) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
