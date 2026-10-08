import React from "react";
import ReactDOM from "react-dom/client";
import { RendererRoot } from "./app/routing/RendererRoot";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RendererRoot />
  </React.StrictMode>,
);
