import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ResizeSeparator } from "../../shared/ui/ResizeSeparator";

// The selected commit's changes never shrink below this, however far the graph is dragged.
const CHANGES_MIN_HEIGHT = 180;

/**
 * History's main column: the commit graph on top and the selected commit's changes below,
 * divided by a draggable rule. Without a graph (focus mode) the changes take the whole column.
 */
export function HistorySplit({ graph, changes, graphHeight, minGraphHeight, maxGraphHeight, label, onResizeGraph }: {
  graph?: ReactNode;
  changes: ReactNode;
  graphHeight: number;
  minGraphHeight: number;
  maxGraphHeight: number;
  label: string;
  onResizeGraph: (height: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number>();

  useEffect(() => {
    const node = container.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.height));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Cap the graph so the changes keep their minimum; the stored height comes back once the window grows.
  const max = available ? Math.max(minGraphHeight, Math.min(maxGraphHeight, available - CHANGES_MIN_HEIGHT)) : maxGraphHeight;
  const height = Math.min(graphHeight, max);
  return (
    <div ref={container} className="historySplit" style={{ "--history-graph-height": `${height}px` } as CSSProperties}>
      {graph}
      {graph && <ResizeSeparator orientation="horizontal" edge="top" value={height} min={minGraphHeight} max={max} label={label} onResize={onResizeGraph} />}
      {changes}
    </div>
  );
}
