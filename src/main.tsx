import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DiffWindow } from "./features/diff/DiffWindow";
import { ConflictWindow } from "./features/workflows/ConflictWindow";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("view") === "diff"
      ? <DiffWindow />
      : new URLSearchParams(window.location.search).get("view") === "conflicts"
        ? <ConflictWindow />
        : <App />}
  </React.StrictMode>,
);
