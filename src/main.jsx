import { render } from "preact";
import { App } from "./App.jsx";
import "./styles.css";
import { locale, t } from "../shared/i18n.js";

document.documentElement.lang = locale;
document.title = t("app.title");
document.querySelector('meta[name="description"]')?.setAttribute("content", t("app.description"));

render(<App />, document.getElementById("app"));
