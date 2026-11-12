import { t } from "../shared/i18n.js";
import { useLayoutEffect, useState } from "preact/hooks";
import { useCompactLayout } from "./hooks/useMediaQuery.js";
import { RouteScope, useRouter } from "./hooks/useRouter.jsx";
import { parseRoute, safeReturnPath } from "../shared/routes.js";
import { UploadPage } from "./features/uploads/UploadPage.jsx";
import { LibraryApp } from "./features/library/LibraryApp.jsx";
import { AccountPage } from "./components/AccountPage.jsx";
import { AdminRoute } from "./components/AdminRoute.jsx";

function RoutedPage({ route }) {
  return route.page === "admin" ? (
    <AdminRoute />
  ) : route.page === "upload" ? (
    <UploadPage key={route.token} token={route.token} />
  ) : route.page === "not-found" ? (
    <main class="setup-page">
      <h1>{t("library.pageNotFound")}</h1>
      <a href="/">{t("library.backToHome")}</a>
    </main>
  ) : (
    <LibraryApp />
  );
}

export function App() {
  const router = useRouter();
  const { route, state, initial } = router;
  const mobile = useCompactLayout();
  const accountOpen = route.page === "account";
  const [closingAccount, setClosingAccount] = useState(null);
  useLayoutEffect(() => {
    if (mobile && accountOpen) setClosingAccount(route);
    else if (!mobile) setClosingAccount(null);
  }, [mobile, accountOpen, route]);
  const accountRoute = accountOpen ? route : mobile ? closingAccount : null;
  const from =
    mobile && accountOpen && !initial
      ? safeReturnPath(state.accountFrom, "")
      : "";
  const background = from ? parseRoute(from) : accountOpen ? null : route;
  const target = accountRoute
    ? safeReturnPath(
        new URL(accountRoute.href, location.origin).searchParams.get("return"),
        "/",
      )
    : "/";
  const returnTo = parseRoute(target).page === "account" ? "/" : target;
  return (
    <>
      <RouteScope
        route={background}
        state={from ? state.accountBackgroundState || {} : state}
      >
        {background && <RoutedPage route={background} />}
      </RouteScope>
      {accountRoute && (
        <AccountPage
          mobile={mobile}
          open={accountOpen}
          animateEntry={!!from}
          returnTo={returnTo}
          onClose={() => {
            if (accountOpen) router.close("accountFrom", returnTo);
          }}
          onExited={() => setClosingAccount(null)}
        />
      )}
    </>
  );
}
