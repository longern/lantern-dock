import { AlbumViewer } from "../album/AlbumViewer.jsx";
import { FilePreview } from "./FilePreview.jsx";

export function LibraryPreview({
  client,
  state,
  records,
  transfer,
  copyLink,
  fileURL,
  toast,
  feedback,
  fileFeedback,
}) {
  const {
    selected,
    thumbnail,
    gallery,
    preview,
    previewOpen,
    previewEpoch,
    onPreviewEntered,
    closePreview,
    finishPreview,
    previewReturnTarget,
  } = state;
  if (!selected || !client) return null;
  return gallery ? (
    <AlbumViewer
      key={previewEpoch}
      gallery={gallery}
      item={selected}
      client={client}
      open={previewOpen}
      onSelect={(item) => preview(item, gallery)}
      favorite={records.isFavorite(selected)}
      onFavorite={records.toggleFavorite}
      onDownload={transfer.download}
      shareURL={fileURL(selected, true)}
      toast={toast}
      onClose={closePreview}
      onExited={finishPreview}
      returnTarget={previewReturnTarget}
      feedback={feedback}
    />
  ) : (
    <FilePreview
      key={selected.path}
      item={selected}
      thumbnail={thumbnail}
      client={client}
      favorite={records.isFavorite(selected)}
      onFavorite={records.toggleFavorite}
      onDownload={transfer.download}
      onCopyLink={copyLink}
      onError={(text) => toast(text, true)}
      onClose={closePreview}
      open={previewOpen}
      onEntered={onPreviewEntered}
      onExited={finishPreview}
      returnTarget={previewReturnTarget}
      feedback={fileFeedback}
    />
  );
}
