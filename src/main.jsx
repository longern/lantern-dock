import { render } from "preact";
import { App } from "./App.jsx";
import { SessionProvider } from "./hooks/useSession.jsx";
import { RouterProvider } from "./hooks/useRouter.jsx";
import "./styles.css";
import { locale, t } from "../shared/i18n.js";
import { siteTitle } from "./lib/site-title.js";

document.documentElement.lang = locale;
document.title = t("app.title", { siteTitle });
document
  .querySelector('meta[name="description"]')
  ?.setAttribute("content", t("app.description"));

render(
  <RouterProvider>
    <SessionProvider>
      <App />
    </SessionProvider>
  </RouterProvider>,
  document.getElementById("app"),
);
