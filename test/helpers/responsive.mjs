import { breakpoints } from "../../src/lib/breakpoints.js";
export { breakpoints };
export const isCompact = (page) =>
  page.viewportSize().width < breakpoints.values.md;
export const isPhone = (page) =>
  page.viewportSize().width < breakpoints.values.sm;
export const isModalPreview = (page) =>
  page.viewportSize().width < breakpoints.values.lg;
