export function bytes(size) {
  if (size == null) return "—";
  if (size < 1024) return size + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return value.toFixed(value >= 100 ? 0 : 1) + " " + units[index];
}

export function date(value, full = false) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(
    "zh-CN",
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
