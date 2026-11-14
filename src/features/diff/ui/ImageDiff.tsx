import { MetaList } from "../../../shared/ui/MetaList";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { useEffect, useState } from "react";
import { GitCrestApiError } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { formatLfsSize } from "../model/lfs-pointer";

type Side = "old" | "new";
type Mode = "side" | "swipe" | "onion";

export interface ImageSource {
  /** Loads one side of the file; a missing side rejects with a 404, an oversize one with a 413. */
  load: (side: Side) => Promise<{ blob: Blob; type: string; size: number }>;
}

type SideState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "tooLarge" }
  | { kind: "error" }
  | { kind: "ready"; url: string; size: number; width: number | null; height: number | null };

const COMPARABLE = /\.(png|jpe?g|gif|webp|svg)$/i;

export function isComparableImagePath(path: string): boolean {
  return COMPARABLE.test(path);
}

/** How long to wait for a picture to report its size before showing it without one. */
const SIZE_TIMEOUT_MS = 3000;

function sizeOf(url: string): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve({ width: null, height: null }), SIZE_TIMEOUT_MS);
    image.onload = () => { window.clearTimeout(timer); resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null }); };
    image.onerror = () => { window.clearTimeout(timer); resolve({ width: null, height: null }); };
    image.src = url;
  });
}

/**
 * Compares the two versions of a picture: side by side, with a swipe divider, or as an onion skin.
 * SVG files are shown through an image element, never inserted as markup, so nothing in them runs.
 */
export function ImageDiff({ path, source }: { path: string; source: ImageSource }) {
  const { t } = useI18n();
  const [sides, setSides] = useState<Record<Side, SideState>>({ old: { kind: "loading" }, new: { kind: "loading" } });
  const [mode, setMode] = useState<Mode>("side");
  const [position, setPosition] = useState(50);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setSides({ old: { kind: "loading" }, new: { kind: "loading" } });
    (["old", "new"] as const).forEach((side) => {
      source.load(side).then(async (loaded) => {
        const url = URL.createObjectURL(loaded.blob);
        urls.push(url);
        const dimensions = await sizeOf(url);
        if (active) setSides((current) => ({ ...current, [side]: { kind: "ready", url, size: loaded.size, ...dimensions } }));
      }).catch((reason) => {
        if (!active) return;
        const status = reason instanceof GitCrestApiError ? reason.status : 0;
        setSides((current) => ({ ...current, [side]: { kind: status === 404 ? "missing" : status === 413 ? "tooLarge" : "error" } }));
      });
    });
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [source]);

  const before = sides.old;
  const after = sides.new;
  const both = before.kind === "ready" && after.kind === "ready";
  const anyLoading = before.kind === "loading" || after.kind === "loading";

  const describe = (state: SideState) => state.kind === "ready"
    ? <MetaList items={[state.width && state.height ? `${state.width}×${state.height}` : t("img.unknownSize"), formatLfsSize(state.size)]} />
    : state.kind === "missing" ? t("img.none") : state.kind === "tooLarge" ? t("img.tooLarge") : state.kind === "error" ? t("img.failed") : t("img.loading");
  const change = both
    ? after.size === before.size ? t("img.sameSize") : `${after.size > before.size ? "+" : "−"}${formatLfsSize(Math.abs(after.size - before.size))}`
    : "";

  function picture(state: SideState, side: Side) {
    return state.kind === "ready"
      ? <img src={state.url} alt={t(side === "old" ? "img.altBefore" : "img.altAfter", { path })} draggable={false} />
      : <p className="cloneHelp" role={state.kind === "error" ? "alert" : "status"}>{describe(state)}</p>;
  }

  return <div className="imageDiff" aria-label={t("img.aria", { path })}>
    <div className="imageDiffToolbar" role="toolbar" aria-label={t("img.modes")}>
      {(["side", "swipe", "onion"] as const).map((option) => <button key={option} type="button" className={mode === option ? "active" : undefined} aria-pressed={mode === option} disabled={option !== "side" && !both} title={option !== "side" && !both ? t("img.needsBoth") : undefined} onClick={() => setMode(option)}>{t(`img.mode.${option}`)}</button>)}
      {mode === "swipe" && both && <label className="imageDiffSlider">{t("img.swipe")}<input type="range" min={0} max={100} value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>}
      {mode === "onion" && both && <label className="imageDiffSlider">{t("img.onion")}<input type="range" min={0} max={100} value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>}
    </div>
    <p className="imageDiffFacts" role="status">
      <span>{t("img.before")}: {describe(before)}</span>
      <span aria-hidden="true"><UiIcon name="arrowRight" /></span>
      <span>{t("img.after")}: {describe(after)}</span>
      {change && <strong>{t("img.change", { change })}</strong>}
    </p>
    {anyLoading && <p role="status" className="cloneHelp">{t("img.loading")}</p>}
    {mode === "side" || !both
      ? <div className="imageDiffSides">
        <figure><figcaption>{t("img.before")}</figcaption>{picture(before, "old")}</figure>
        <figure><figcaption>{t("img.after")}</figcaption>{picture(after, "new")}</figure>
      </div>
      : mode === "swipe"
        ? <div className="imageDiffStack" style={{ ["--swipe" as string]: `${position}%` }}>
          <img className="imageDiffBase" src={before.url} alt={t("img.altBefore", { path })} draggable={false} />
          <img className="imageDiffSwipe" src={after.url} alt={t("img.altAfter", { path })} draggable={false} />
        </div>
        : <div className="imageDiffStack">
          <img className="imageDiffBase" src={before.url} alt={t("img.altBefore", { path })} draggable={false} />
          <img className="imageDiffOnion" src={after.url} alt={t("img.altAfter", { path })} draggable={false} style={{ opacity: position / 100 }} />
        </div>}
  </div>;
}
