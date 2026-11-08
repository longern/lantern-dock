import { t, locale } from "../../shared/i18n.js";

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function modifiedTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i.exec(text);
  const http = /^(?:[a-z]+,\s*)(\d{1,2})[ -]([a-z]{3})[ -](\d{2}|\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(text);
  const asctime = /^[a-z]{3} ([a-z]{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i.exec(text);
  if (!iso && !http && !asctime) return null;
  let timestamp = Date.parse(asctime ? text + " GMT" : text);
  if (!Number.isFinite(timestamp)) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const [year, month, day, hour, minute, second] = iso
    ? [+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)]
    : http
      ? [new Date(timestamp).getUTCFullYear(), months.indexOf(http[2].toLowerCase()) + 1, +http[1], +http[4], +http[5], +http[6]]
      : [+asctime[6], months.indexOf(asctime[1].toLowerCase()) + 1, +asctime[2], +asctime[3], +asctime[4], +asctime[5]];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59)
    return null;
  if (iso && !iso[4]) {
    // A date-only value denotes that local calendar day, not midnight UTC.
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    timestamp = date.getTime();
  }
  return timestamp;
}

export function groupMediaByDate(entries, now = new Date()) {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const media = entries
    .filter((item) => !item.isDirectory && ["image", "video"].includes(item.kind))
    .map((item) => ({ item, timestamp: modifiedTimestamp(item.modified) }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return b.timestamp - a.timestamp;
      }
      return a.item.name.localeCompare(b.item.name, locale, { numeric: true }) ||
        a.item.path.localeCompare(b.item.path, locale);
    });
  const groups = new Map();
  for (const { item, timestamp } of media) {
    const date = timestamp === null ? null : new Date(timestamp);
    const key = date ? dayKey(date) : "unknown";
    if (!groups.has(key)) {
      const label = !date ? t("core.album.unknown")
        : date.getFullYear() !== now.getFullYear()
          ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(date)
          : key === today ? t("core.album.today")
            : key === yesterday ? t("core.album.yesterday")
              : new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(date);
      groups.set(key, { key, label, items: [] });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}
