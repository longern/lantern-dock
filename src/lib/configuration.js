import { locale } from "../../shared/i18n.js";

export function fetchConfiguration(signal) {
  return fetch("/api/config", {
    cache: "no-store",
    headers: { "Accept-Language": locale },
    signal,
  });
}
