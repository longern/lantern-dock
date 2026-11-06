import { useEffect, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { limitedBytes } from "../lib/dav.js";
import { bytes, date } from "../lib/format.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { Dialog } from "./Dialog.jsx";
import { VideoPreview } from "./VideoPreview.jsx";

export function FilePreview({
  item,
  client,
  favorite,
  onFavorite,
  onDownload,
  onError,
  onClose,
  onExited,
  open,
  feedback,
}) {
  const modal = useMediaQuery("(max-width: 1000px)");
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let url;
    setContent(null);
    setError("");
    setDimensions("");
    (async () => {
      try {
        if (item.kind === "video") {
          setContent({ video: true });
          return;
        }
        if (!["image", "text"].includes(item.kind)) {
          setError("下载后查看此文件");
          return;
        }
        if (item.kind === "image" && client.images) {
          const show = (image) => {
            if (!image || controller.signal.aborted) return;
            if (url) URL.revokeObjectURL(url);
            url = URL.createObjectURL(image.blob);
            setContent({ url, width: image.width, height: image.height });
            setDimensions(`${image.width} × ${image.height}`);
          };
          show(client.images.peek(item, 1600));
          const image = await client.images.image(
            item,
            1600,
            controller.signal,
          );
          if (image) {
            show(image);
            return;
          }
        }
        const limit = (item.kind === "image" ? 25 : 1) * 1024 * 1024;
        if (item.size > limit)
          throw new Error("文件超过预览大小限制，请下载原文件查看。");
        const response = await client.get(item.path, controller.signal);
        const data = await limitedBytes(response, limit, controller.signal);
        if (controller.signal.aborted) return;
        if (item.kind === "text") {
          setContent({ text: new TextDecoder().decode(data) });
          return;
        }
        const mime = response.headers.get("Content-Type")?.split(";")[0];
        if (mime && !mime.startsWith("image/"))
          throw new Error("后端没有返回图片，可能需要重新登录。");
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(
          new Blob([data], { type: mime || "image/*" }),
        );
        setContent({ url });
      } catch (error) {
        if (!controller.signal.aborted) {
          setError("无法预览此文件，请下载查看。");
          onError(error.message);
        }
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, client, client.images?.revision]);

  return (
    <Dialog
      open={open}
      modal={modal}
      onClose={onClose}
      onExited={onExited}
      id="preview-dialog"
      class="preview-dialog"
      aria-labelledby="preview-name"
    >
      <div class="preview-header">
        <button class="icon-button" aria-label="关闭预览" onClick={onClose}>
          <Icon name={modal ? "chevron-left" : "x"} />
        </button>
        <strong id="preview-name">{item.name}</strong>
        <button
          class="icon-button"
          aria-label={favorite ? "取消收藏文件" : "收藏文件"}
          aria-pressed={favorite}
          style={{ color: favorite ? "#a58b41" : undefined }}
          onClick={() => onFavorite(item)}
        >
          <Icon name="star" />
        </button>
      </div>
      <div class="preview-scroll">
        <div class="preview-content">
          {error || !content ? (
            <div class="preview-placeholder">
              <Icon name={item.kind} />
              <p role="status">{error || "正在加载预览…"}</p>
            </div>
          ) : content.video ? (
            <VideoPreview
              item={item}
              client={client}
              open={open}
              onError={onError}
              onDimensions={(width, height) =>
                setDimensions(`${width} × ${height}`)
              }
            />
          ) : content.text !== undefined ? (
            <pre>{content.text}</pre>
          ) : (
            <img
              src={content.url}
              alt={item.name}
              onLoad={(event) =>
                setDimensions(
                  `${content.width || event.currentTarget.naturalWidth} × ${content.height || event.currentTarget.naturalHeight}`,
                )
              }
              onError={() => {
                setError("无法预览此图片，请下载查看。");
                onError("无法预览此图片，请下载查看。");
              }}
            />
          )}
        </div>
        <dl class="file-details">
          <div>
            <dt>类型</dt>
            <dd>{item.mime || item.name.split(".").pop().toUpperCase()}</dd>
          </div>
          <div>
            <dt>大小</dt>
            <dd>{bytes(item.size)}</dd>
          </div>
          {dimensions && (
            <div>
              <dt>尺寸</dt>
              <dd>{dimensions}</dd>
            </div>
          )}
          <div>
            <dt>修改时间</dt>
            <dd>{date(item.modified, true)}</dd>
          </div>
        </dl>
      </div>
      <div class="preview-actions">
        <button class="primary-button" onClick={() => onDownload(item)}>
          <Icon name="download" />
          下载
        </button>
      </div>
      {feedback}
    </Dialog>
  );
}
