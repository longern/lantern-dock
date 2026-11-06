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
| Home categories       | White album, video, document, book and audio cards on a light gray canvas. The album uses an icon above its label, never a thumbnail. Cards filter the root directory and a second click clears the filter. |
| File states           | No table header for errors or empty results; retry, clear search and clear file-type actions. Loading feedback on refresh.                                                                           |
| Notifications         | Translucent black, white-text notification below center; manual popover layer keeps feedback and download cancellation above modal content.                                                          |
| Copy                  | Short action labels and state messages. Connection troubleshooting is disclosed on demand. Account technical identifiers collapse after administrator setup; bootstrap identifiers remain available. |

## Maintaining the interface

- Define palette, radius and motion values in `src/styles/base.css`. Overlay animations belong in `src/styles/overlays.css`.
- Use `Dialog` rather than directly unmounting a modal. Set `open` false on dismissal, and remove ephemeral content in `onExited`. Cancel exit cleanup if the same surface reopens.
- Keep surface and backdrop mounted for the same exit duration. A `hidden` scrim cannot animate out.
- Do not mix the file service's credentials with account login. Connection help may describe protocol requirements; normal file browsing should not require protocol knowledge.
- Use concise inline guidance and actionable empty states. Keep deployment instructions and identifiers in setup or expandable details.
- Home category cards appear in the root file view, not inside folders or local-record views. Documents include text, PDF and Office formats; books include EPUB, MOBI and other ebook formats. Categories do not enable new preview formats or recursively scan directories.
- Verify keyboard dismissal, background inertness, focus restoration, reduced motion, narrow layouts and content overflow when changing an overlay.

`test/browser/interactions.spec.mjs` covers these interaction contracts alongside the file-browser and setup suites. Real bridge tests validate preview, download, inbox and identity flows against the production frontend. Chromium mobile viewports do not replace physical Safari/iOS or Android device testing.
