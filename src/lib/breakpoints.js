// MUI's default breakpoint values and exclusive upper-bound step (5 / 100 px).
const values = Object.freeze({ xs: 0, sm: 600, md: 900, lg: 1200, xl: 1536 });
const keys = Object.keys(values);
const value = (key) => {
  if (!Object.hasOwn(values, key))
    throw new Error(`Unknown breakpoint: ${key}`);
  return values[key];
};
const up = (key) => `(min-width: ${value(key)}px)`;
const down = (key) => `(max-width: ${value(key) - 0.05}px)`;
const between = (start, end) => {
  if (value(start) >= value(end))
    throw new Error(`Invalid breakpoint range: ${start}–${end}`);
  return `${up(start)} and ${down(end)}`;
};
export const breakpoints = Object.freeze({
  values,
  up,
  down,
  between,
  only: (key) => {
    const index = keys.indexOf(key);
    value(key);
    return index === keys.length - 1 ? up(key) : between(key, keys[index + 1]);
  },
});

export const mediaQueries = Object.freeze({
  compact: down("md"),
  reducedMotion: "(prefers-reduced-motion: reduce)",
});
