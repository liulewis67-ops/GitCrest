import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface ResizeSeparatorProps {
  orientation: "vertical" | "horizontal";
  /** Which side of the rule the resized panel sits on; "top" grows as the rule moves down. */
  edge: "left" | "right" | "top" | "bottom";
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (value: number) => void;
}

/** While a rule is dragged, the whole window keeps its resize cursor and nothing gets text-selected. */
const RESIZING_CLASS = { vertical: "resizingColumns", horizontal: "resizingRows" } as const;

export function ResizeSeparator({
  orientation,
  edge,
  value,
  min,
  max,
  label,
  onResize,
}: ResizeSeparatorProps) {
  const drag = useRef<{ pointerId: number; coordinate: number; value: number }>();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add(RESIZING_CLASS[orientation]);
    return () => root.classList.remove(RESIZING_CLASS[orientation]);
  }, [dragging, orientation]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      coordinate: orientation === "vertical" ? event.clientX : event.clientY,
      value,
    };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const sign = edge === "left" ? 1 : -1;
    const delta = orientation === "horizontal"
      ? (event.clientY - drag.current.coordinate) * (edge === "bottom" ? -1 : 1)
      : (event.clientX - drag.current.coordinate) * sign;
    onResize(Math.max(min, Math.min(max, drag.current.value + delta)));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const increaseKeys = orientation === "vertical" ? ["ArrowRight", "ArrowUp"] : edge === "top" ? ["ArrowDown", "ArrowRight"] : ["ArrowUp", "ArrowRight"];
    const decreaseKeys = orientation === "vertical" ? ["ArrowLeft", "ArrowDown"] : edge === "top" ? ["ArrowUp", "ArrowLeft"] : ["ArrowDown", "ArrowLeft"];
    if (increaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.min(max, value + 16));
    } else if (decreaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.max(min, value - 16));
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(max);
    }
  }

  return (
    <div
      className={`resizeSeparator ${orientation}${dragging ? " dragging" : ""}`}
      data-edge={edge}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
