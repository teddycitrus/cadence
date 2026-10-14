import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { adoptOrgFromUrl } from "./org";
import { initTheme } from "./theme";

// Before anything talks to the server: which organization this tab is in.
adoptOrgFromUrl();
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
