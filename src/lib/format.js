import { locale } from "../../shared/i18n.js";

export function bytes(size) {
  if (size == null) return "—";
  if (size < 1024) return new Intl.NumberFormat(locale).format(size) + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  const digits = value >= 100 ? 0 : 1;
  return (
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value) +
    " " +
    units[index]
  );
}

export function date(value, full = false) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(
    locale,
    full
      ? {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : { month: "2-digit", day: "2-digit" },
  ).format(parsed);
}
