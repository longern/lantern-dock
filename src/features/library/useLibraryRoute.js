import { libraryLocation, albumHref } from "../../../shared/routes.js";
import { useRouter } from "../../hooks/useRouter.jsx";
export function useLibraryRoute() {
  const router = useRouter();
  const current = libraryLocation(router.route, router.state);
  const route = ["favorites", "me", "album"].includes(current.surface)
    ? current.surface
    : null;
  return {
    route,
    navigate(next, replace = false) {
      router.navigate(
        next === "album"
          ? albumHref(current.directory)
          : next
            ? `/${next}`
            : "/",
        { replace, state: { surfaceFrom: router.route.href } },
      );
    },
    closeFavorites: (mobile) => {
      if (mobile && router.state.surfaceFrom !== "/me")
        router.navigate("/me", { replace: true });
      else router.close("surfaceFrom", mobile ? "/me" : "/");
    },
    closeAlbum: () => router.close("surfaceFrom", "/"),
  };
}
