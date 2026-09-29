import type { FC } from "react";

interface GeminiIconProps {
  className?: string;
}

export const GeminiIcon: FC<GeminiIconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Gemini"
  >
    <defs>
      <linearGradient
        id="gemini-gradient"
        x1="0"
        y1="0"
        x2="28"
        y2="28"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0%" stopColor="#4285F4" suppressHydrationWarning />
        <stop offset="50%" stopColor="#9B72CB" suppressHydrationWarning />
        <stop offset="100%" stopColor="#D96570" suppressHydrationWarning />
      </linearGradient>
    </defs>
    <path
      d="M14 2C14 8.627 8.627 14 2 14C8.627 14 14 19.373 14 26C14 19.373 19.373 14 26 14C19.373 14 14 8.627 14 2Z"
      fill="url(#gemini-gradient)"
    />
  </svg>
);
