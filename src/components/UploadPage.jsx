import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { UploadClient } from "../lib/uploads.js";
import { bytes, date } from "../lib/format.js";

export function UploadPage({ token }) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const client = useRef(null);
  const active = useRef(null);
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const stop = () => {
      active.current?.abort();
      client.current?.close();
    };
    window.addEventListener("pagehide", stop);
    setLink(null);
    setError("");
    (async () => {
      try {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
          throw new Error("收件链接无效，请向收件人索取完整链接。");
        const response = await fetch("/api/config", {
          cache: "no-store",
          signal: controller.signal,
        });
        const config = await response.json();
        if (
          !response.ok ||
          config.setupRequired ||
          !config.backend ||
          config.backend.transport === "demo"
        )
          throw new Error("站点尚未连接收件服务，请联系收件人完成配置。");
        if (controller.signal.aborted) return;
        const connection = new UploadClient(config.backend, token);
        client.current = connection;
        const info = await connection.info(controller.signal);
        if (!controller.signal.aborted) setLink(info);
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      }
    })();
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", stop);
      controller.abort();
      active.current?.abort();
      client.current?.close();
      client.current = null;
    };
  }, [token, revision]);
  const update = (id, patch) => {
    if (mounted.current)
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
  };
  const receive = async (files) => {
    if (running.current || !client.current || !link || !files.length) return;
    const connection = client.current;
    const batch = Array.from(files, (file) => ({
      id: crypto.randomUUID(),
      file,
      status: "queued",
      loaded: 0,
    }));
    setRows((current) => [...current, ...batch]);
    setWorking(true);
    running.current = true;
    try {
      for (const row of batch) {
        if (!mounted.current || client.current !== connection) break;
        const controller = new AbortController();
        active.current = controller;
        update(row.id, { status: "uploading" });
        try {
          await connection.upload(row.file, {
            signal: controller.signal,
            onProgress: (loaded) => update(row.id, { loaded }),
          });
          update(row.id, { status: "complete", loaded: row.file.size });
        } catch (err) {
          update(row.id, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: err.message,
          });
        }
        active.current = null;
        try {
          const info = await connection.info(AbortSignal.timeout(5000));
          if (mounted.current && client.current === connection) setLink(info);
        } catch (err) {
          if (mounted.current && client.current === connection)
            setError(err.message);
          for (const pending of batch.slice(batch.indexOf(row) + 1))
            update(pending.id, { status: "cancelled" });
          break;
        }
      }
    } finally {
      active.current = null;
      running.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const remaining = link ? Math.max(0, link.maxTotalBytes - link.usedBytes) : 0;
  const available =
    link &&
    !error &&
    remaining > 0 &&
    link.usedFiles < link.maxFiles &&
    Date.parse(link.expiresAt) > Date.now();
  return (
    <main class="setup-page upload-page">
      <a class="setup-brand" href="/">
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>LanternDock</span>
      </a>
      <section class="setup-card" aria-labelledby="upload-title">
        <div class="setup-intro">
          <span class="setup-eyebrow">临时收件箱</span>
          <h1 id="upload-title">{link?.title || "接收文件"}</h1>
          <p>
            文件直接发送给收件人。上传内容不会自动公开，也不会显示其他人的文件。
          </p>
        </div>
        {!link && !error && (
          <p class="upload-message" role="status">
            正在连接收件箱…
          </p>
        )}
        {link && (
          <dl class="upload-limits">
            <div>
              <dt>单文件上限</dt>
              <dd>{bytes(link.maxFileBytes)}</dd>
            </div>
            <div>
              <dt>剩余容量</dt>
              <dd>{bytes(remaining)}</dd>
            </div>
            <div>
              <dt>剩余文件数</dt>
              <dd>{Math.max(0, link.maxFiles - link.usedFiles)}</dd>
            </div>
            <div>
              <dt>有效期至</dt>
              <dd>{date(link.expiresAt, true)}</dd>
            </div>
          </dl>
        )}
        {error && (
          <div class="upload-message" role="alert">
            <p>{error}</p>
            <button
              class="secondary-button"
              disabled={working}
              onClick={() => setRevision((value) => value + 1)}
            >
              重新检测
            </button>
          </div>
        )}
        {link && !error && (
          <label
            class={`upload-drop${working || !available ? " disabled" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (available) void receive(event.dataTransfer.files);
            }}
          >
            <Icon name="upload" />
            <strong>
              {working
                ? "正在上传文件"
                : available
                  ? "选择文件或拖放到这里"
                  : "收件箱已达到限额或已过期"}
            </strong>
            <span>
              {working
                ? "可以取消当前文件的上传"
                : "支持一次选择多个文件，按顺序上传"}
            </span>
            <input
              type="file"
              multiple
              disabled={working || !available}
              aria-label="选择上传文件"
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (files?.length) void receive(files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        )}
        {!!rows.length && (
          <ul class="upload-results" aria-label="本次上传">
            {rows.map((row) => (
              <li key={row.id}>
                <div class="upload-file-heading">
                  <strong>{row.file.name}</strong>
                  <span>{bytes(row.file.size)}</span>
                </div>
                {row.status === "uploading" && (
                  <>
                    <progress
                      value={row.loaded}
                      max={row.file.size || 1}
                      aria-label={`${row.file.name} 上传进度`}
                    />
                    <div class="upload-file-status">
                      <span>
                        {row.loaded >= row.file.size
                          ? "正在确认接收…"
                          : `${bytes(row.loaded)} / ${bytes(row.file.size)}`}
                      </span>
                      <button
                        class="text-button"
                        onClick={() => active.current?.abort()}
                      >
                        取消上传
                      </button>
                    </div>
                  </>
                )}
                <span class={`upload-result ${row.status}`} role="status">
                  {row.status === "complete"
                    ? "已接收"
                    : row.status === "queued"
                      ? "等待上传"
                      : row.status === "cancelled"
                        ? "已取消"
                        : row.status === "failed"
                          ? row.error
                          : "上传中"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <a class="upload-back" href="/">
          返回公开文件
        </a>
      </section>
    </main>
  );
}
