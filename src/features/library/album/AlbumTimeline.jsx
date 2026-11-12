import { Component } from "preact";

export class AlbumTimeline extends Component {
  getSnapshotBeforeUpdate(previous) {
    const { entries, revision, scope, listRef } = this.props;
    if (
      previous.scope !== scope ||
      previous.entries === entries ||
      (revision && previous.revision === revision)
    )
      return null;

    const list = listRef.current;
    const dialog = list.closest(".page-dialog");
    const scroller = dialog || document.scrollingElement;
    if (!scroller.scrollTop) return null;

    const header = dialog
      ? dialog.querySelector(".page-dialog-header")
      : list.closest(".main-area")?.querySelector(".browser-header");
    const top = Math.max(0, header?.getBoundingClientRect().bottom || 0);
    const bottom = dialog?.getBoundingClientRect().bottom ?? innerHeight;
    const anchors = [];
    for (const photo of list.querySelectorAll("button[data-path]")) {
      const rect = photo.getBoundingClientRect();
      if (rect.top >= bottom) break;
      if (rect.bottom > top) anchors.push([photo.dataset.path, rect.top]);
    }
    return { scroller, anchors };
  }

  componentDidUpdate(_props, _state, snapshot) {
    if (!snapshot) return;
    const { scroller, anchors } = snapshot;
    for (const [path, top] of anchors) {
      const photo = this.props.listRef.current.querySelector(
        `button[data-path="${CSS.escape(path)}"]`,
      );
      if (!photo) continue;
      // Correct only the remaining offset after the browser's scroll anchoring.
      const offset = photo.getBoundingClientRect().top - top;
      if (Math.abs(offset) >= 1) scroller.scrollTop += offset;
      break;
    }
  }

  render({ entries, revision, scope, listRef, ...props }) {
    return <div ref={listRef} {...props} />;
  }
}
