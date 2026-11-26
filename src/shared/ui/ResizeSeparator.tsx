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
  const drag = useRef<{ pointerId: number; coordinate: number; value: number; nextValue?: number; frame?: number }>();
  const separatorRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => {
    if (drag.current?.frame !== undefined) cancelAnimationFrame(drag.current.frame);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add(RESIZING_CLASS[orientation]);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(true);
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      root.classList.remove(RESIZING_CLASS[orientation]);
      document.removeEventListener("keydown", escape, true);
    };
  }, [dragging, orientation]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      coordinate: orientation === "vertical" ? event.clientX : event.clientY,
      value,
    };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const session = drag.current;
    if (session?.pointerId !== event.pointerId) return;
    const sign = edge === "left" ? 1 : -1;
    const delta = orientation === "horizontal"
      ? (event.clientY - session.coordinate) * (edge === "bottom" ? -1 : 1)
      : (event.clientX - session.coordinate) * sign;
    session.nextValue = Math.max(min, Math.min(max, session.value + delta));
    if (session.frame === undefined) {
      session.frame = requestAnimationFrame(() => {
        session.frame = undefined;
        const next = session.nextValue;
        session.nextValue = undefined;
        if (next !== undefined) resizeRef.current(next);
      });
    }
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    finishDrag(false);
  }

  function finishDrag(cancelled: boolean) {
    const session = drag.current;
    if (!session) return;
    drag.current = undefined;
    if (session.frame !== undefined) cancelAnimationFrame(session.frame);
    setDragging(false);
    if (cancelled) resizeRef.current(session.value);
    else if (session.nextValue !== undefined) resizeRef.current(session.nextValue);
    if (separatorRef.current?.hasPointerCapture?.(session.pointerId)) separatorRef.current.releasePointerCapture(session.pointerId);
  }

  function cancelDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) finishDrag(true);
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
      ref={separatorRef}
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
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onKeyDown={onKeyDown}
    />
  );
}
