# Page URLs and navigation

LanternDock uses the browser History API. The URL identifies the current directory, file preview or application page; a shared URL works in a fresh tab and after reload. Legacy hash routes are not supported.

| Page                            | Example                                                  |
| ------------------------------- | -------------------------------------------------------- |
| Home                            | `/`                                                      |
| File root                       | `/files/`                                                |
| Directory                       | `/files/Projects/`                                       |
| File preview                    | `/files/Projects/guide.pdf`                              |
| Album                           | `/album/` or `/album/Photos/`                            |
| Photo in album context          | `/files/Photos/coast.jpg?view=album`                     |
| Favorites / Me / account        | `/favorites`, `/me`, `/account`                          |
| Administration                  | `/admin/links`, `/admin/inbox`, `/admin/inbox?link=<id>` |
| Temporary collection permission | `/upload#token=<random-token>`                           |

File and album paths are relative to the configured public WebDAV root. They never contain a NAS filesystem mount, bridge session URL or backend host. Encode each filename segment exactly once; case, Unicode, spaces, `%`, `#` and `?` in names are preserved. Directory URLs end with `/`, including directories whose names look like filenames. Files can have no extension. A directory opened without the final slash is recognized using its parent's DAV metadata and canonicalized.

Direct file links obtain metadata from the parent's normal `PROPFIND Depth: 1`, then open the corresponding preview. No extra original-file read is needed to locate a file. Missing files show an explicit unavailable state instead of opening an unrelated item. Moving or renaming a resource invalidates its old path link; persistent share objects are a separate future feature.

`?q=` records the search, and `?type=` supports `image`, `text`, `video`, `book` and `audio`. Search edits replace the current entry instead of filling browser history for every keystroke. Sort and list/grid controls remain presentation preferences. Internal preview entry state can preserve Home, Favorites or a filtered background, but the file URL alone can always reconstruct its parent directory. That state contains no credentials.

Opening a directory or preview pushes an entry. Changing photos replaces the current preview entry, keeping the address accurate without requiring Back once per photo. Back closes a preview before its parent album; Forward restores the file. Closing an internally opened preview goes Back to its recorded background. A preview opened directly uses its directory/album as the safe close destination. The router owns history; overlay components own animation and focus only.

Mobile album previews use swipes, without visible left/right pager buttons. Desktop retains pager buttons and keyboard navigation. Native video controls keep their seek gestures; swiping the video picture can still change pages. File, folder and preview copy-link actions generate portal URLs.

## Workers and login

The site keeps one SPA entry. Public pages are statically imported, so normal visitors do not wait for another page module request. Administration is loaded with a route-local lazy boundary, including its dedicated CSS. Upload, invitation and account styles used by public pages stay in the shared stylesheet. Loading or failing to load administration shows a lightweight page with a return link; retry reloads the current URL to recover from network errors or an outdated asset reference.

Administration entries use ordinary same-tab anchors. The router handles normal internal clicks through the History API; modified clicks, middle clicks and new-tab actions retain browser behavior. Switching between the public library and administration unmounts the previous page tree. Library cleanup cancels requests and downloads, stops album polling, disposes image and directory memory caches, revokes preview URLs and closes its transport. Imported modules can remain cached by the browser; unmounting releases page resources rather than unloading JavaScript itself. Returning to the library establishes a fresh connection. The shared identity/NAS session provider stays mounted across routes.

Clicking an administration link during a library upload or download asks before interrupting the transfer. Active transfers also register the browser's normal document-exit warning. This is an anchor-click guard, not a general History API blocker; same-document Back/Forward navigation still follows the normal cleanup behavior.

`assets.not_found_handling: "single-page-application"` serves the SPA for deep browser navigation. `/api`, `/api/*`, `/auth`, `/auth/*` and the authorization metadata path retain Worker-first routing. Unknown reserved API/auth endpoints return JSON `404`, rather than the HTML SPA fallback. Unknown page URLs render the app's not-found view; as with static SPA fallbacks, the shell can have HTTP status `200`.

OIDC continues to use `/auth/callback` and the existing CIMD client ID. Login sends its current page as `returnTo`; the Worker accepts only recognized local page destinations and binds the result into encrypted OAuth state. A successful callback returns there. External destinations, API paths and upload credentials cannot become return locations. Oversized return URLs fall back to `/account` so encrypted state stays within cookie limits. `/account?return=<local-page>` supplies the account page's back destination without session-storage hints.

The upload token is a bearer permission in the fragment, not a page route. Browsers do not send fragments with the initial page request; the client sends the token to the NAS in `Authorization`. Query parameters are used for ordinary page state, not collection credentials. A fragment does not protect against XSS, browser history or someone receiving the full link. Existing CSP, output escaping, expiry and NAS-side permission checks still apply. Worker certificate webhook URLs and NAS DAV/API routes are unchanged.
