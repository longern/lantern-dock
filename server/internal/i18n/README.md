# NAS translations

The embedded `locales/en.json` and `locales/zh-CN.json` catalogs contain NAS API
copy. Add the same key to both catalogs and use `Translator.T(key, values)` for
optional `{{name}}` interpolation. Missing translations fall back to English,
then the key. Values are interpolated once; HTTP output is escaped by its encoder.

`New(acceptLanguage)` selects a language from the browser's `Accept-Language`
header. Quality weights take priority, followed by header order. English and
Chinese variants resolve to `en` and `zh-CN`; other languages and wildcards
are skipped before falling back to English. The header is bounded to 4096 bytes;
malformed tags or quality weights (including duplicates) are ignored. There is no persistent or global current-language setting.

NAS faults carry translation keys through storage and background media helpers.
The HTTP error writer translates using the original request, sets
`Content-Language`, and varies errors by `Accept-Language`. Successful file,
metadata, and account responses are unchanged. Error codes, HTTP status codes,
OAuth protocol fields and authentication challenges remain stable. In
particular, OAuth `error_description` stays an ASCII diagnostic; its companion
`message` is localized.

User filenames, stored inbox titles, identities, and administrator configuration
are never treated as translation keys. The CLI has no browser language, so a
new link's default title is taken from the English catalog and then stored as
ordinary user-visible data.

Run `go test -race ./...` from `server/` to cover negotiation, fallback,
interpolation, request isolation, representative API errors, and protocol
compatibility. The existing UTF-8 filename fixtures intentionally remain
non-English to cover filesystem and wire behavior.
