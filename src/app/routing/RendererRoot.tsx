import { ConflictWindow } from "../../features/workflows/ConflictWindow";
import { DiffWindow } from "../../features/diff/DiffWindow";
import App from "../../App";
import { resolveRendererView } from "./renderer-view";

export function RendererRoot() {
  switch (resolveRendererView(window.location.search)) {
    case "diff":
      return <DiffWindow />;
    case "conflicts":
      return <ConflictWindow />;
    case "workspace":
      return <App />;
  }
}
