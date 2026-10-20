import React from "react";
import ReactDOM from "react-dom/client";
import { RendererRoot } from "./app/routing/RendererRoot";
import { startAppearance } from "./features/settings";
import "./styles/globals.css";

// Apply the saved theme and text sizes before the first paint, in every window.
startAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RendererRoot />
  </React.StrictMode>,
);
