import { kindFor } from "./dav.js";
import { t } from "../../shared/i18n.js";
const stamp = "2026-11-04T08:30:00Z";
const file = (name, size, dir = false, modified = stamp) => ({
  name,
  size: dir ? null : size,
  isDirectory: dir,
  modified,
  kind: kindFor(name, dir),
  mime: "",
  etag: "",
});
const root = [
  file(t("demo.photos"), 0, true),
  file(t("demo.documents"), 0, true),
  file(t("demo.videos"), 0, true),
  file(t("demo.music"), 0, true),
  file(t("demo.morning"), 1780),
  file(t("demo.seaside"), 1650),
  file(t("demo.notes"), 1248),
  file(t("demo.reading"), 684),
  file(t("demo.design"), 492),
  file(t("demo.archive"), 12582912),
  file(t("demo.journey"), 1540),
  file(t("demo.guide"), 980),
];
const folders = {
  "/": root,
  [`/${encodeURIComponent(t("demo.photos"))}/`]: [
    file(t("demo.morning"), 1780),
    file(t("demo.seaside"), 1650),
    file(t("demo.journey"), 1540),
    file(t("demo.forest"), 1400),
  ],
  [`/${encodeURIComponent(t("demo.documents"))}/`]: [
    file(t("demo.notes"), 1248),
    file(t("demo.reading"), 684),
    file(t("demo.design"), 492),
  ],
  [`/${encodeURIComponent(t("demo.videos"))}/`]: [],
  [`/${encodeURIComponent(t("demo.music"))}/`]: [],
};
export function artwork(name) {
  const ocean = name === t("demo.seaside");
  const forest = name === t("demo.forest");
  const sky = ocean ? "#cedfe0" : forest ? "#c7d6bf" : "#efe2ca";
  const back = ocean ? "#728e97" : forest ? "#738e70" : "#b5b2a0";
  const front = ocean ? "#405e68" : forest ? "#344e44" : "#64766d";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="${sky}"/><circle cx="880" cy="180" r="90" fill="#faf3d9"/><path d="M0 510 L210 240 L415 470 L650 140 L940 520 L1200 250 V800 H0Z" fill="${back}"/><path d="M0 670 L260 440 L490 590 L750 390 L1200 650 V800 H0Z" fill="${front}"/><path d="M0 730 Q260 600 570 745 T1200 730 V800 H0Z" fill="${ocean ? "#b4cbc8" : "#d9d5bc"}" opacity=".8"/></svg>`;
}
export class DemoClient {
  constructor() {
    this.root = "/";
  }
  async list(path, signal) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    signal?.throwIfAborted();
    return (folders[path] || []).map((item) => ({
      ...item,
      path:
        path + encodeURIComponent(item.name) + (item.isDirectory ? "/" : ""),
    }));
  }
  async get(path, signal) {
    signal?.throwIfAborted();
    const name = decodeURIComponent(path.split("/").pop());
    if (name.endsWith(".svg"))
      return new Response(artwork(name), {
        headers: { "Content-Type": "image/svg+xml" },
      });
    if (name.endsWith(".json"))
      return new Response(
        JSON.stringify(
          {
            project: "LanternDock",
            transport: ["HTTPS", "WebTransport"],
            files: "WebDAV",
            privacy: t("demo.privacy"),
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    if (name.endsWith(".zip"))
      throw new Error(t("demo.unavailable"));
    const text = name === t("demo.reading")
      ? t("demo.readingText")
      : t("demo.markdown", { name: name.replace(/\.[^.]+$/, "") });
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
