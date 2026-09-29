import * as React from "react";
import InputPhone from "react-phone-number-input/input";
import { cn } from "@/lib/utils";
import { ChevronsUpDown } from "lucide-react";

export const PhoneInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof InputPhone>
>(({ className, ...props }, ref) => {
  return (
    <div className={cn("flex w-full rounded-md border border-input bg-background overflow-hidden transition-colors", className)}>
      <div className="flex items-center gap-1.5 bg-muted/50 px-3 py-2 border-r border-input shrink-0">
        <span className="text-base leading-none block">🇮🇳</span>
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      </div>
      {/* react-phone-number-input/input ships no subpath types; its default export marks
          value/onChange required, so the forwarded spread trips a false positive. The
          consumer (Controller field) always supplies them. Cast is local, no behavior change. */}
      <InputPhone
        ref={ref}
        className="flex h-10 w-full bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 border-none"
        {...(props as React.ComponentProps<typeof InputPhone> & {
          onChange: (value?: string) => void;
        })}
      />
    </div>
  );
});
PhoneInput.displayName = "PhoneInput";
