export function selectPaths(
  state,
  order,
  path,
  { range = false, toggle = false, mode = "desktop" } = {},
) {
  const end = order.indexOf(path);
  if (end < 0) return state;
  if (range) {
    const start = order.indexOf(state.anchor);
    const anchor = start < 0 ? end : start;
    const paths = new Set(toggle ? state.paths : []);
    for (const item of order.slice(
      Math.min(anchor, end),
      Math.max(anchor, end) + 1,
    ))
      paths.add(item);
    return { paths, anchor: order[anchor], mode };
  }
  const paths = new Set(toggle ? state.paths : []);
  if (toggle && paths.has(path)) paths.delete(path);
  else paths.add(path);
  return {
    paths,
    anchor: path,
    mode: paths.size || mode === "touch" ? mode : null,
  };
}
