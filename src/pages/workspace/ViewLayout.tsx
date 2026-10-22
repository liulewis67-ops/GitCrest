import type { CSSProperties, ReactNode } from "react";
import { ResizeSeparator } from "../../shared/ui/ResizeSeparator";

type PanelSize = { width: number; min: number; max: number; label: string; onResize: (width: number) => void };

/**
 * Lays out one task view: an optional sidebar, the main content, and an optional inspector.
 * Hidden panels leave no gap; the main content always takes the remaining width. An overlay
 * inspector floats over the main content instead of narrowing it.
 */
export function ViewLayout({ className, sidebar, sidebarSize, inspector, inspectorSize, inspectorOverlay, children }: {
  className: string;
  sidebar?: ReactNode;
  sidebarSize: PanelSize;
  inspector?: ReactNode;
  inspectorSize: PanelSize;
  inspectorOverlay: boolean;
  children: ReactNode;
}) {
  const dockedInspector = Boolean(inspector) && !inspectorOverlay;
  const columns = [
    sidebar ? "var(--view-sidebar-width) 6px" : "",
    "minmax(0, 1fr)",
    dockedInspector ? "6px var(--view-inspector-width)" : "",
  ].filter(Boolean).join(" ");
  const style = {
    "--view-sidebar-width": `${sidebarSize.width}px`,
    "--view-inspector-width": `${inspectorSize.width}px`,
    gridTemplateColumns: columns,
  } as CSSProperties;
  return (
    <div className={`viewLayout ${className}`} style={style}>
      {sidebar}
      {sidebar && <ResizeSeparator orientation="vertical" edge="left" value={sidebarSize.width} min={sidebarSize.min} max={sidebarSize.max} label={sidebarSize.label} onResize={sidebarSize.onResize} />}
      <div className="viewMain">{children}</div>
      {dockedInspector && <ResizeSeparator orientation="vertical" edge="right" value={inspectorSize.width} min={inspectorSize.min} max={inspectorSize.max} label={inspectorSize.label} onResize={inspectorSize.onResize} />}
      {inspector}
    </div>
  );
}
