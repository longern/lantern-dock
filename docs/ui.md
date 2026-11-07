# Interface conventions

LanternDock keeps its Preact components and restrained purple palette. Shared behavior and visual tokens follow the same principles used by mature component libraries: consistent transitions, accessible modal lifecycles, predictable controls and concise copy. Reference: Material UI [drawers](https://mui.com/material-ui/react-drawer/), [dialogs](https://mui.com/material-ui/react-dialog/) and [transitions](https://mui.com/material-ui/customization/transitions/).

## Interaction audit

| Area                  | Implemented behavior                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile navigation     | Native modal drawer; slide and backdrop fade on both entry and exit; close button, backdrop and Escape dismissal.                                                                                    |
| Settings and previews | Shared `Dialog` lifecycle retains the surface and backdrop until exit completes. Desktop preview remains non-modal; tablet/mobile preview is modal.                                                  |
| Keyboard              | Modal Tab/Shift+Tab loop; background inertness; focus restoration and fallback when an opener has disappeared; search shortcut ignores editable fields and modifiers.                                |
| Responsive changes    | Leaving the mobile breakpoint releases the drawer; previews adapt between side panel and modal.                                                                                                      |
| Motion                | Shared 220 ms entry / 180 ms exit and easing tokens. System reduced-motion preference disables both surface and pseudo-element backdrop animation and closes without an animation delay.             |
| Controls              | Shared radii, input/button sizing, focus and pressed states. Larger mobile hit areas, 16 px mobile form inputs and safe-area-aware navigation.                                                       |
| Home and files        | Navigation starts with Home and Files. Home has no breadcrumbs and shows browser-local recent visits, newest first, falling back to root files only when history is empty. The mobile list is a full-width white card with rounded top corners that grows down the page. |
| Home categories       | White album, video, document, book and audio shortcuts open the root directory in Files with a type filter. The album uses an icon above its label, never a thumbnail. Search fields stay 36 px tall on desktop and mobile. |
| File states           | No table header for errors or empty results; retry, clear search and clear file-type actions. Loading feedback on refresh.                                                                           |
| Notifications         | Translucent black, white-text notification below center; manual popover layer keeps feedback and download cancellation above modal content.                                                          |
| Copy                  | Short action labels and state messages. Connection troubleshooting is disclosed on demand. Account technical identifiers collapse after administrator setup; bootstrap identifiers remain available. |

## Maintaining the interface

- Define palette, radius and motion values in `src/styles/base.css`. Overlay animations belong in `src/styles/overlays.css`.
- Use `Dialog` rather than directly unmounting a modal. Set `open` false on dismissal, and remove ephemeral content in `onExited`. Cancel exit cleanup if the same surface reopens.
- Keep surface and backdrop mounted for the same exit duration. A `hidden` scrim cannot animate out.
- Do not mix the file service's credentials with account login. Connection help may describe protocol requirements; normal file browsing should not require protocol knowledge.
- Use concise inline guidance and actionable empty states. Keep deployment instructions and identifiers in setup or expandable details.
- Home category cards appear only on Home. Documents include text, PDF and Office formats; books include EPUB, MOBI and other ebook formats. Categories do not enable new preview formats or recursively scan directories.
- Recent files come from the current backend's browser-local visit history (up to 30 previewed/downloaded files), not server modification times. Choose the recent/root source before searching so unmatched recent searches do not silently fall back to other files. The mobile Home card uses an unpadded parent and flex growth, never negative margins to cancel padding.
- Verify keyboard dismissal, background inertness, focus restoration, reduced motion, narrow layouts and content overflow when changing an overlay.

`test/browser/interactions.spec.mjs` covers these interaction contracts alongside the file-browser and setup suites. Real bridge tests validate preview, download, inbox and identity flows against the production frontend. Chromium mobile viewports do not replace physical Safari/iOS or Android device testing.
