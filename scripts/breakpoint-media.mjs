import { breakpoints } from "../src/lib/breakpoints.js";

// Expand named CSS media queries from the same definition used by JS hooks.
// Vite runs this PostCSS plugin in both development and production builds.
export function resolveBreakpointMedia(query) {
  return query.replace(/\(--([\w-]+)\)/g, (_, name) => {
    const [method, start, end, extra] = name.split("-");
    if (
      extra ||
      !["up", "down", "only", "between"].includes(method) ||
      (method === "between" ? !end : end)
    )
      throw new Error(`Unknown breakpoint media query: ${name}`);
    return breakpoints[method](start, end);
  });
}

export function breakpointMedia() {
  return {
    postcssPlugin: "lantern-dock-breakpoint-media",
    AtRule: {
      media(rule) {
        rule.params = resolveBreakpointMedia(rule.params);
      },
    },
  };
}
