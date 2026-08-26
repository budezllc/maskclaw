import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const mount = document.querySelector("#app");
if (!(mount instanceof HTMLElement)) {
  throw new Error("missing #app");
}

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
