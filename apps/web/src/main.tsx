import ReactDOM from "react-dom/client";
import type { ReactNode } from "react";
import { IconContext } from "@phosphor-icons/react";
import { configureAPI } from "@interleaf/api";
import { App } from "./App";
import { installCloseFlush } from "./close-flush";
import { AppCrash, ErrorBoundary } from "./ErrorBoundary";
import "@fontsource-variable/inter/wght.css";
import "./style.css";
import "./rounded-interface.css";
import "./reader-rounded.css";
import { installDiagnostics } from "./diagnostics";
import { installScrollbars } from "./scrollbars";
import { migrateLegacyStorage } from "./legacy-storage";
try {
  migrateLegacyStorage(localStorage);
  migrateLegacyStorage(sessionStorage);
} catch {}
const removeScrollbars = installScrollbars(document);
if (import.meta.hot) import.meta.hot.dispose(removeScrollbars);
const token =
  new URLSearchParams(location.hash.slice(1)).get("token") ||
  sessionStorage.getItem("interleaf-session") ||
  "";
if (token) {
  sessionStorage.setItem("interleaf-session", token);
  history.replaceState(null, "", location.pathname + location.search);
}
configureAPI(token);
const removeDiagnostics = installDiagnostics(token);
if (import.meta.hot) import.meta.hot.dispose(removeDiagnostics);
const root = ReactDOM.createRoot(document.getElementById("root")!);
const mount = (node: ReactNode) =>
  root.render(
    <IconContext.Provider value={{ weight: "regular", size: 16 }}>
      {node}
    </IconContext.Provider>,
  );
if (import.meta.env.DEV && location.pathname === "/__streaming-benchmark") {
  void import("./chat/StreamingBenchmark").then(({ default: Benchmark }) =>
    mount(<Benchmark />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__streaming") {
  void import("./chat/StreamingPreview").then(({ default: Preview }) =>
    mount(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__link-preview") {
  void import("./LinkPreviewDemo").then(({ default: Preview }) =>
    mount(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__formula-caption") {
  void import("./translation/FormulaCaptionPreview").then(
    ({ default: Preview }) => mount(<Preview />),
  );
} else if (import.meta.env.DEV && location.pathname === "/__processing-cover") {
  void import("./CoverProcessingPreview").then(({ default: Preview }) =>
    mount(<Preview />),
  );
} else {
  const removeCloseFlush = installCloseFlush();
  if (import.meta.hot) import.meta.hot.dispose(removeCloseFlush);
  mount(
    <ErrorBoundary fallback={<AppCrash />}>
      <App />
    </ErrorBoundary>,
  );
}
