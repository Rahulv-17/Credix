"use client"

import { cn } from "@/lib/utils"

interface SiriOrbProps {
  size?: string
  className?: string
  colors?: {
    c1?: string
    c2?: string
    c3?: string
  }
  animationDuration?: number
}

const SiriOrb: React.FC<SiriOrbProps> = ({
  size = "192px",
  className,
  colors,
  animationDuration = 20,
}) => {
  const c1 = colors?.c1 ?? "oklch(75% 0.15 350)"
  const c2 = colors?.c2 ?? "oklch(80% 0.12 200)"
  const c3 = colors?.c3 ?? "oklch(78% 0.14 280)"

  const sizeValue = parseInt(size, 10)
  const blurAmount = Math.max(sizeValue * 0.1, 3)
  const contrastAmount = Math.max(sizeValue * 0.003, 1.8)

  return (
    <div
      className={cn("siri-orb", className)}
      style={
        {
          width: size,
          height: size,
          "--c1": c1,
          "--c2": c2,
          "--c3": c3,
          "--animation-duration": `${animationDuration}s`,
          "--blur-amount": `${blurAmount}px`,
          "--contrast-amount": contrastAmount,
        } as React.CSSProperties
      }
    />
  )
}

export { SiriOrb }
export default SiriOrb
