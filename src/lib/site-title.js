export function resolveSiteTitle(value) {
  return value?.trim() || "LanternDock";
}

export const siteTitle = resolveSiteTitle(import.meta.env?.VITE_SITE_TITLE);
