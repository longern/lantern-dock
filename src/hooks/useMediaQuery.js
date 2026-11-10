import { useLayoutEffect, useMemo, useState } from "preact/hooks";
import { breakpoints, mediaQueries } from "../lib/breakpoints.js";

export function useMediaQuery(query) {
  const media = useMemo(() => globalThis.matchMedia?.(query), [query]);
  const [, setMatches] = useState(() => media?.matches ?? false);
  useLayoutEffect(() => {
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [media]);
  // A changed query must use its current match before the subscription commits.
  return media?.matches ?? false;
}

export const useBreakpointUp = (key) => useMediaQuery(breakpoints.up(key));
export const useBreakpointDown = (key) => useMediaQuery(breakpoints.down(key));
export const useBreakpointBetween = (start, end) =>
  useMediaQuery(breakpoints.between(start, end));
export const useCompactLayout = () => useMediaQuery(mediaQueries.compact);
export const useReducedMotion = () => useMediaQuery(mediaQueries.reducedMotion);
