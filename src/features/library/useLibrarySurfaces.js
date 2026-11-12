import { useLayoutEffect, useState } from "preact/hooks";
import { useLibraryRoute } from "./useLibraryRoute.js";

export function useLibrarySurfaces(source, mobile) {
  const navigation = useLibraryRoute();
  const { route } = navigation;
  const favoritesOpen = mobile && route === "favorites";
  const [favoritesMounted, setFavoritesMounted] = useState(favoritesOpen);
  const [favoritesSort, setFavoritesSort] = useState("name");
  const albumOpen = mobile && route === "album";
  const [albumMounted, setAlbumMounted] = useState(albumOpen);
  const albumPresent = mobile && (albumOpen || albumMounted);
  const myPage =
    route === "me" || (mobile && (route === "favorites" || favoritesMounted));
  const library = {
    ...source,
    ...(route === "album" && !mobile ? source.album : {}),
    ...(route === "album" && !mobile
      ? {
          error: !source.connection ? source.error : null,
        }
      : {}),
    mode:
      route === "favorites"
        ? "favorites"
        : myPage
          ? "me"
          : route === "album" && !mobile
            ? "all"
            : source.mode,
    // Routed account/favorite surfaces never inherit a hidden Home search or filter.
    query: route ? "" : source.query,
    kind:
      route === "album"
        ? mobile
          ? source.kind === "album"
            ? ""
            : source.kind
          : "album"
        : route
          ? ""
          : source.kind,
  };
  const basePage = !route || albumOpen;
  const collectionPage =
    basePage &&
    (library.mode === "home" ||
      (library.mode === "all" && !["album", "image"].includes(library.kind)));
  useLayoutEffect(() => {
    if (favoritesOpen) setFavoritesMounted(true);
    else if (!mobile) setFavoritesMounted(false);
    if (albumOpen) setAlbumMounted(true);
    else if (!mobile) setAlbumMounted(false);
    if (!mobile && route === "me") navigation.navigate(null, true);
  }, [mobile, route]);

  return {
    navigation,
    route,
    library,
    basePage,
    collectionPage,
    myPage,
    albumOpen,
    albumPresent,
    finishAlbum: () => setAlbumMounted(false),
    favoritesOpen,
    favoritesPresent: mobile && (favoritesOpen || favoritesMounted),
    finishFavorites: () => setFavoritesMounted(false),
    favoritesSort,
    setFavoritesSort,
  };
}
