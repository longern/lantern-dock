import test from "node:test";
import assert from "node:assert/strict";
import { fileListing, listingPreferences } from "../src/lib/file-listing.js";

const file = (name, visitedAt = 0, modified = "2020-01-01") => ({
  name,
  path: "/" + name,
  kind: "text",
  isDirectory: false,
  visitedAt,
  modified,
});
const directory = [file("directory-only.md"), file("another.md")];
const library = (overrides = {}) => ({
  mode: "home",
  entries: directory,
  sort: "recent",
  kind: "",
  query: "",
  ...overrides,
});
const records = (recent = [], favorites = [], overrides = {}) => ({
  recent,
  favorites,
  recentStatus: "ready",
  recentError: null,
  favoritesStatus: "ready",
  favoritesError: null,
  ...overrides,
});

test("header preferences share recent eligibility without reading or sorting directory entries", () => {
  const source = library({ view: "grid", sort: "size" });
  Object.defineProperty(source, "entries", {
    get() {
      throw new Error("Header must not scan entries");
    },
  });
  assert.deepEqual(listingPreferences(source, records()), {
    recent: false,
    album: false,
    sort: "size",
    view: "grid",
  });
  for (const recentStatus of ["pending", "error", "ready"]) {
    assert.deepEqual(
      listingPreferences(
        source,
        records([file("recent.md")], [], { recentStatus }),
      ),
      {
        recent: true,
        album: false,
        sort: "recent",
        view: "list",
      },
    );
  }
});

test("album and favorites header preferences agree with their content model", () => {
  for (const kind of ["album", "image", "text", ""]) {
    const source = library({
      mode: "all",
      kind,
      sort: "modified",
      view: "grid",
    });
    const preference = listingPreferences(source, records([file("recent.md")]));
    const listing = fileListing(source, records([file("recent.md")]));
    assert.equal(preference.album, ["album", "image"].includes(kind));
    for (const key of ["recent", "album", "sort", "view"])
      assert.equal(listing[key], preference[key]);
  }
  assert.deepEqual(
    listingPreferences(
      library({ mode: "favorites", sort: "name", view: "grid" }),
      records([file("recent.md")]),
    ),
    {
      recent: false,
      album: false,
      sort: "name",
      view: "grid",
    },
  );
});

test("home keeps the recent source while its backend namespace is unresolved", () => {
  const result = fileListing(
    library(),
    records([file("previous-backend.md", 20)], [], { recentStatus: "pending" }),
  );
  assert.equal(result.recent, true);
  assert.equal(result.recordsPending, true);
  assert.equal(result.usesDirectory, false);
  assert.equal(result.sort, "recent");
  assert.deepEqual(result.entries, []);
});

test("a recent-history read error never falls back to directory entries", () => {
  const error = new Error("storage unavailable");
  const result = fileListing(
    library(),
    records([], [], { recentStatus: "error", recentError: error }),
  );
  assert.equal(result.recent, true);
  assert.equal(result.recordsPending, false);
  assert.equal(result.recordsError, error);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, []);
});

test("file navigation remains available when recent history is pending or unreadable", () => {
  for (const recentStatus of ["pending", "error"]) {
    const result = fileListing(
      library({ mode: "all" }),
      records([], [], { recentStatus }),
    );
    assert.equal(result.recent, false);
    assert.equal(result.recordsPending, false);
    assert.equal(result.recordsError, null);
    assert.equal(result.usesDirectory, true);
    assert.equal(result.entries.length, 2);
  }
});

test("home falls back to directory files only when recent history is empty", () => {
  const result = fileListing(library(), records());
  assert.equal(result.recent, false);
  assert.equal(result.usesDirectory, true);
  assert.equal(result.sort, "name");
  assert.deepEqual(
    result.entries.map((item) => item.name),
    ["another.md", "directory-only.md"],
  );
  assert.deepEqual(
    fileListing(library({ entries: [] }), records()).entries,
    [],
  );
});

test("home uses visit history, ordered by last visit rather than filename or modification date", () => {
  const older = file("aaa.md", 10, "2030-01-01");
  const newer = file("zzz.md", 20, "2000-01-01");
  const history = [older, newer];
  const result = fileListing(library(), records(history));
  assert.equal(result.recent, true);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, [newer, older]);
  assert.deepEqual(
    history,
    [older, newer],
    "sorting must not mutate stored records",
  );
});

test("no search results in recent history do not trigger directory fallback", () => {
  const result = fileListing(
    library({ query: "directory-only" }),
    records([file("recent.md", 20)]),
  );
  assert.equal(result.recent, true);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, []);
});

test("file navigation and type filtering use directory entries, not recent history", () => {
  const recent = [file("recent.md", 20)];
  const result = fileListing(
    library({ mode: "all", kind: "text", query: "directory" }),
    records(recent),
  );
  assert.equal(result.recent, false);
  assert.equal(result.usesDirectory, true);
  assert.deepEqual(
    result.entries.map((item) => item.name),
    ["directory-only.md"],
  );
});

test("album search includes videos and does not show an empty state for video-only directories", () => {
  const video = { ...file("clip.mp4"), kind: "video" };
  const image = { ...file("photo.png"), kind: "image" };
  const result = fileListing(
    library({
      mode: "all",
      kind: "album",
      entries: [image, video, file("notes.md")],
    }),
    records(),
  );
  assert.deepEqual(result.entries, [video, image]);
  const searched = fileListing(
    library({
      mode: "all",
      kind: "album",
      entries: [image, video],
      query: "clip",
    }),
    records(),
  );
  assert.deepEqual(searched.entries, [video]);
  assert.deepEqual(
    fileListing(
      library({ mode: "all", kind: "album", entries: [video] }),
      records(),
    ).entries,
    [video],
  );
  assert.deepEqual(
    fileListing(library({ mode: "all", kind: "album", entries: [] }), records())
      .entries,
    [],
  );
});

test("favorites keep their own source and never fall back to directory files", () => {
  const favorite = file("favorite.md");
  assert.deepEqual(
    fileListing(library({ mode: "favorites" }), records([], [favorite]))
      .entries,
    [favorite],
  );
  const empty = fileListing(
    library({ mode: "favorites" }),
    records([file("recent.md")]),
  );
  assert.equal(empty.usesDirectory, false);
  assert.deepEqual(empty.entries, []);
});

test("favorites wait for their backend namespace without showing an empty or directory source", () => {
  const result = fileListing(
    library({ mode: "favorites" }),
    records([], [], {
      favoritesStatus: "pending",
    }),
  );
  assert.equal(result.recordsPending, true);
  assert.equal(result.recordsError, null);
  assert.equal(result.recent, false);
  assert.equal(result.usesDirectory, false);
  assert.deepEqual(result.entries, []);
});

test("favorites storage errors stay errors until a successful retry supplies the favorite source", () => {
  const error = new Error("favorites storage unavailable");
  const failed = fileListing(
    library({ mode: "favorites" }),
    records([file("recent.md")], [], {
      favoritesStatus: "error",
      favoritesError: error,
    }),
  );
  assert.equal(failed.recordsPending, false);
  assert.equal(failed.recordsError, error);
  assert.equal(failed.usesDirectory, false);
  assert.deepEqual(failed.entries, []);
  const favorite = file("restored-favorite.md");
  const recovered = fileListing(
    library({ mode: "favorites" }),
    records([], [favorite]),
  );
  assert.equal(recovered.recordsError, null);
  assert.equal(recovered.recordsPending, false);
  assert.deepEqual(recovered.entries, [favorite]);
});

test("favorites availability is independent of recent history and never blocks ordinary files", () => {
  for (const status of ["pending", "error"]) {
    const error = new Error("unrelated record failure");
    const favorite = file("favorite.md");
    const favorites = fileListing(
      library({ mode: "favorites" }),
      records([], [favorite], {
        recentStatus: status,
        recentError: error,
      }),
    );
    assert.equal(favorites.recordsPending, false);
    assert.equal(favorites.recordsError, null);
    assert.deepEqual(favorites.entries, [favorite]);
    for (const mode of ["all", "home"]) {
      const files = fileListing(
        library({ mode }),
        records([], [], {
          favoritesStatus: status,
          favoritesError: error,
        }),
      );
      assert.equal(files.recordsPending, false);
      assert.equal(files.recordsError, null);
      assert.equal(files.usesDirectory, true);
      assert.equal(files.entries.length, 2);
    }
  }
});

test("recent sorting is fixed even when another view has selected a different sort", () => {
  const older = { ...file("aaa.md", 10, "2030-01-01"), size: 100 };
  const newer = { ...file("zzz.md", 20, "2000-01-01"), size: 1 };
  for (const sort of ["recent", "name", "modified", "size"]) {
    const result = fileListing(library({ sort }), records([older, newer]));
    assert.equal(result.sort, "recent");
    assert.deepEqual(result.entries, [newer, older]);
  }
});

test("recent files always use list layout without changing the saved view preference", () => {
  const source = library({ view: "grid", sort: "size" });
  const result = fileListing(source, records([file("recent.md", 20)]));
  assert.equal(result.view, "list");
  assert.equal(result.sort, "recent");
  assert.equal(source.view, "grid");
  assert.equal(source.sort, "size");
  for (const recentStatus of ["pending", "error"]) {
    assert.equal(
      fileListing(source, records([], [], { recentStatus })).view,
      "list",
    );
  }
});

test("ordinary files, favorites and the empty-history fallback preserve view choices", () => {
  for (const mode of ["home", "all", "favorites"]) {
    for (const view of ["grid", "list"]) {
      const result = fileListing(library({ mode, view }), records());
      assert.equal(result.view, view);
    }
  }
});

test("recent sorting handles missing visit timestamps stably", () => {
  const first = file("zzz.md");
  const second = file("aaa.md");
  assert.deepEqual(fileListing(library(), records([first, second])).entries, [
    first,
    second,
  ]);
  assert.deepEqual(
    fileListing(library({ sort: "name" }), records([first, second])).entries,
    [first, second],
  );
});

test("empty-history fallback and ordinary files still honor sorting choices", () => {
  const small = { ...file("aaa.md"), size: 1 };
  const large = { ...file("zzz.md"), size: 100 };
  for (const mode of ["home", "all"]) {
    const result = fileListing(
      library({ mode, entries: [small, large], sort: "size" }),
      records(),
    );
    assert.equal(result.sort, "size");
    assert.deepEqual(result.entries, [large, small]);
  }
});
