import { kindFor } from "./dav.js";
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
  file("照片", 0, true),
  file("工作文档", 0, true),
  file("视频", 0, true),
  file("音乐", 0, true),
  file("山间清晨.svg", 1780),
  file("海边的周末.svg", 1650),
  file("项目笔记.md", 1248),
  file("阅读清单.txt", 684),
  file("设计说明.json", 492),
  file("归档资料.zip", 12582912),
  file("旅途随拍.svg", 1540),
  file("使用指南.md", 980),
];
const folders = {
  "/": root,
  "/%E7%85%A7%E7%89%87/": [
    file("山间清晨.svg", 1780),
    file("海边的周末.svg", 1650),
    file("旅途随拍.svg", 1540),
    file("林间微光.svg", 1400),
  ],
  "/%E5%B7%A5%E4%BD%9C%E6%96%87%E6%A1%A3/": [
    file("项目笔记.md", 1248),
    file("阅读清单.txt", 684),
    file("设计说明.json", 492),
  ],
  "/%E8%A7%86%E9%A2%91/": [],
  "/%E9%9F%B3%E4%B9%90/": [],
};
export function artwork(name) {
  const ocean = name.includes("海");
  const forest = name.includes("林");
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
            privacy:
              "Your files travel directly between your browser and your backend.",
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    if (name.endsWith(".zip"))
      throw new Error("这是演示条目。连接真实后端后即可下载文件。");
    const text = name.includes("阅读")
      ? "阅读清单\n\n01. HTTP Semantics — RFC 9110\n02. WebDAV — RFC 4918\n03. WebTransport — W3C\n\n保持好奇，慢慢阅读。"
      : `# ${name.replace(/\.[^.]+$/, "")}\n\n欢迎使用 LanternDock。\n\n这是一份演示文件，用来体验文件浏览、预览、收藏与下载。\n\n## 连接方式\n\nWorker 只下发配置，文件数据由浏览器直接连接后端。\n支持 HTTPS 和 WebTransport，文件接口使用 WebDAV。\n\n## 你的数据\n\n登录凭据只保存在当前页面内存中。\n收藏和最近访问记录保存在此浏览器。\n\n配置真实后端后，此演示内容将被你的文件替换。`;
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
