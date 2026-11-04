const paths = {
  portal:
    '<path d="M8 5h8l4 4-3 12H7L4 9Z"/><path d="M9 5V3h6v2M4 9h16M9 21h6M12 10v7"/>',
  folder: '<path d="M3 7h7l2 3h9v10H3Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  cloud:
    '<path d="M7 18H6a4 4 0 0 1-1-7.9 6 6 0 0 1 11.5-1.5A4.7 4.7 0 0 1 18 18h-2"/><path d="m9 16 3 3 3-3m-3 3V11"/>',
  settings:
    '<path d="m9 4 1-2h4l1 2 2 1 2-.1 2 3.5-1.2 1.8v3.6L21 16l-2 3.5-2-.1-2 1-1 2h-4l-1-2-2-1-2 .1L3 16l1.2-1.7v-3.6L3 9l2-3.5 2 .1Z" transform="translate(0 -1) scale(1 .95)"/><circle cx="12" cy="11.5" r="3"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  refresh:
    '<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5m-4 7a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  alert: '<path d="m12 3 10 17H2Z"/><path d="M12 9v4m0 3v.5"/>',
  "folder-search":
    '<path d="M3 7h7l2 3h9v5M3 7v14h8"/><circle cx="15" cy="17" r="4"/><path d="m18 20 3 3"/>',
  file: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h4M9 12h6m-6 4h6"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  text: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h4M9 11h6m-6 4h6m-6 4h4"/>',
  pdf: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h4m-8 10 2-6 3 6m-4-2h3"/>',
  video:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>',
  audio:
    '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  archive:
    '<path d="M5 2h14v20H5Z"/><path d="M11 3h2m-2 3h2m-2 3h2m-2 3h2m-2 3h2m-3 3h4v3h-4Z"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plug: '<path d="m8 3 4 4m1-9 4 4M7 7l10 10M6 8l-2 2a5 5 0 0 0 7 7l2-2m-8 4-3 3m7-17 8 8" transform="translate(1 3) scale(.85)"/>',
  sparkles:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Zm7-2v4m-2-2h4"/>',
  "arrow-up-right": '<path d="M6 18 18 6M7 6h11v11"/>',
};
export function Icon({ name, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: paths[name] || paths.file }}
    />
  );
}
