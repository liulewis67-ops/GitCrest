import type { SVGProps } from "react";
const paths = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  external: <><path d="M9 2.5h4.5V7M13.5 2.5 7 9M6 3H3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10" /></>,
  download: <path d="M8 2v9m-3-3 3 3 3-3M3 12v2h10v-2" />,
  plus: <path d="M8 3v10M3 8h10" />,
  arrowRight: <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />,
  arrowUp: <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />,
  arrowDown: <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />,
  more: <><circle cx="3" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="13" cy="8" r=".8" /></>,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  chevronRight: <path d="m6 4 4 4-4 4" />,
  chevronLeft: <path d="m10 4-4 4 4 4" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  branch: <><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" /><path d="M4 4.5v7M12 4.5v1A3.5 3.5 0 0 1 8.5 9H4" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1" /></>,
  star: <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5v-3h-8v8h3" /></>,
  check: <path d="m3 8 3 3 7-7" />,
  undo: <path d="M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8" />,
  refresh: <path d="M13.5 6A5.5 5.5 0 1 0 13 11M13.5 2.5V6H10" />,
} as const;
export type IconName = keyof typeof paths;
/** Authored 16px icons share one stroke weight and inherit semantic foreground color. */
export function Icon({ name, className = "", ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg {...props} className={`gcIcon ${className}`.trim()} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
