export type RendererView = "workspace" | "diff" | "conflicts";

export function resolveRendererView(search: string): RendererView {
  const requestedView = new URLSearchParams(search).get("view");
  if (requestedView === "diff" || requestedView === "conflicts") {
    return requestedView;
  }
  return "workspace";
}
