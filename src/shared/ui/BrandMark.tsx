import { useId } from "react";

interface BrandMarkProps {
  className?: string;
}

// Arms are drawn in a frame rotated outward from the commit, so x runs along the arm. The two slopes are deliberately
// asymmetric, each a line of code with its own token rhythm; their last tokens run past the circle that cuts them.
const ARMS = [
  { angle: 125, endColor: "var(--accent)", tokens: [{ x: 8.5, width: 11.27 }, { x: 21.97, width: 8.03 }] },
  { angle: 38, endColor: "var(--green)", tokens: [{ x: 8.5, width: 4.37 }, { x: 15.07, width: 14.93 }] },
];

// The GitCrest mark drawn from theme tokens, so it follows the active theme. build/icon.svg holds the app icon version.
// The commit sits at the centre and one undrawn circle around it cuts both slopes.
export function BrandMark({ className }: BrandMarkProps) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="6 6 52 52" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`${id}-cut`}>
          <circle cx="32" cy="32" r="26" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-cut)`}>
        {ARMS.map((arm) => (
          <g key={arm.angle} transform={`translate(32 32) rotate(${arm.angle})`} fill={`url(#${id}-arm-${arm.angle})`}>
            <defs>
              <linearGradient id={`${id}-arm-${arm.angle}`} x1="7" y1="0" x2="26" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" style={{ stopColor: "color-mix(in srgb, var(--accent), var(--green))" }} />
                <stop offset="1" style={{ stopColor: arm.endColor }} />
              </linearGradient>
            </defs>
            {arm.tokens.map((token) => <rect key={token.x} x={token.x} y="-3.2" width={token.width} height="6.4" rx="1.9" />)}
          </g>
        ))}
        <path d="M32 24.8V13" stroke="var(--text)" strokeWidth="4.2" />
      </g>
      <circle cx="32" cy="32" r="5.2" fill="none" stroke="var(--text)" strokeWidth="4" />
    </svg>
  );
}
