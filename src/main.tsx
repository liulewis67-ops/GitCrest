import React from "react";
import ReactDOM from "react-dom/client";
import { RendererRoot } from "./app/routing/RendererRoot";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RendererRoot />
  </React.StrictMode>,
);
