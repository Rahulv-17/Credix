"use client";

import { useState, useEffect, useId } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PhoneInput } from "@/components/ui/phone-input";
import { ZapIcon, ZapLogo } from "@/components/icons/zap";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { isValidPhoneNumber } from "react-phone-number-input";
import { z } from "zod";
import type { AuthState } from "@/lib/auth";

// Zod schema for phone validation
const FormSchema = z.object({
  phone: z
    .string()
    .min(1, "Phone number is required")
    .refine((value) => value && isValidPhoneNumber(value), {
      message: "Invalid phone number",
    }),
});

type FormData = z.infer<typeof FormSchema>;

interface PhoneInputScreenProps {
  onVerified: (auth: AuthState) => void;
}

type Stage = "thinking" | "typing" | "input" | "authenticating" | "fetching-profile" | "gliding" | "typing-summary" | "personalized-summary";

export function PhoneInputScreen({ onVerified }: PhoneInputScreenProps) {
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const inputId = useId();

  // Multi-stage state
  const [stage, setStage] = useState<Stage>("thinking");
  const [displayedText, setDisplayedText] = useState("");

  // Auth & Profile Data
  const [authData, setAuthData] = useState<AuthState | null>(null);
  const [profileData, setProfileData] = useState<any>(null);

  const introText = "Hey! I am Rahul, your personalized financial advisor. Please enter your mobile number to get started.";
  const summaryText = authData ? `Hey! This is Rahul, personalized by your choices and preferences. I'll help you manage your finances.` : "";

  const {
    control,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: { phone: "" },
    mode: "onChange",
  });

  const phoneValue = watch("phone");

  // Message Animation States
  const [msg1Full, setMsg1Full] = useState("");
  const [msg1Displayed, setMsg1Displayed] = useState("");
  const [msg2Full, setMsg2Full] = useState("");
  const [msg2Displayed, setMsg2Displayed] = useState("");
  const [msg1Finished, setMsg1Finished] = useState(false);
  const [msg2Started, setMsg2Started] = useState(false);

  const [msg2Finished, setMsg2Finished] = useState(false);
  const [showInput, setShowInput] = useState(false);

  // Initial Typing Animation
  useEffect(() => {
    if (stage === "thinking") {
      const timer = setTimeout(() => setStage("typing"), 1000);
      return () => clearTimeout(timer);
    }
    if (stage === "typing") {
      if (displayedText.length < introText.length) {
        const timeout = setTimeout(() => {
          setDisplayedText(introText.slice(0, displayedText.length + 1));
        }, 30);
        return () => clearTimeout(timeout);
      } else {
        const timer = setTimeout(() => {
          setStage("input");
          // Delay the input reveal so the CSS transition plays
          setTimeout(() => setShowInput(true), 50);
        }, 400);
        return () => clearTimeout(timer);
      }
    }
  }, [stage, displayedText, introText]);

  // Gliding stage: erase old text while container slides up simultaneously
  useEffect(() => {
    if (stage === "gliding") {
      if (displayedText.length > 0) {
        const timeout = setTimeout(() => {
          setDisplayedText(displayedText.slice(0, -2));
        }, 12);
        return () => clearTimeout(timeout);
      } else {
        // Text fully erased, wait for the glide to settle
        const timer = setTimeout(() => setStage("typing-summary"), 500);
        return () => clearTimeout(timer);
      }
    }
  }, [stage, displayedText]);

  // Second Typing Animation (Summary)
  useEffect(() => {
    if (stage === "typing-summary") {
      if (displayedText.length < summaryText.length) {
        const timeout = setTimeout(() => {
          setDisplayedText(summaryText.slice(0, displayedText.length + 1));
        }, 25);
        return () => clearTimeout(timeout);
      } else {
        const timer = setTimeout(() => {
          setStage("personalized-summary");
          if (authData) {
            // Fetch smart reply instead of robotic hardcoded text
            fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mobile: authData.mobile,
                message:
                  "Introduce yourself in one short, friendly line and mention one thing you notice about my finances.",
                session_id: authData.sessionId,
                channel: "web",
              }),
            })
              .then((res) => res.json())
              .then((data) => {
                setMsg1Full(
                  data.response ||
                    "Hey! I'm Rahul, your personal finance credix. Let's take a look at your money together.",
                );
              })
              .catch(() =>
                setMsg1Full(
                  "Hey! I'm Rahul, your personal finance credix. Let's take a look at your money together.",
                ),
              );
          }
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [stage, displayedText, summaryText, authData]);

  // Message 1 Typing
  useEffect(() => {
    if (stage === "personalized-summary" && msg1Full) {
      if (msg1Displayed.length < msg1Full.length) {
        const timeout = setTimeout(() => {
          setMsg1Displayed(msg1Full.slice(0, msg1Displayed.length + 1));
        }, 25);
        return () => clearTimeout(timeout);
      } else if (!msg1Finished) {
        setMsg1Finished(true);
      }
    }
  }, [stage, msg1Full, msg1Displayed, msg1Finished]);

  // Message 2 Fetch and Wait
  useEffect(() => {
    if (stage === "personalized-summary" && authData && !msg2Full) {
      // Static tagline — no second network call.
      setMsg2Full(
        "I'm personalized to your choices and preferences. Ask me anything about your finances whenever you're ready.",
      );
    }
  }, [stage, authData, msg2Full]);

  useEffect(() => {
    if (msg1Finished && msg2Full && !msg2Started) {
      const timer = setTimeout(() => {
        setMsg2Started(true);
      }, 2000); // Wait 2 seconds after msg1 finishes before showing msg2
      return () => clearTimeout(timer);
    }
  }, [msg1Finished, msg2Full, msg2Started]);

  // Message 2 Typing
  useEffect(() => {
    if (msg2Started && msg2Full) {
      if (msg2Displayed.length < msg2Full.length) {
        const timeout = setTimeout(() => {
          setMsg2Displayed(msg2Full.slice(0, msg2Displayed.length + 1));
        }, 25);
        return () => clearTimeout(timeout);
      } else if (!msg2Finished) {
        setMsg2Finished(true);
      }
    }
  }, [msg2Started, msg2Full, msg2Displayed, msg2Finished]);

  const handleContinue = () => {
    if (authData) onVerified(authData);
  };

  // Auto continue after 4 seconds
  useEffect(() => {
    if (msg2Finished) {
      const timer = setTimeout(() => {
        handleContinue();
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [msg2Finished, authData, onVerified]);

  const onSubmit = async (data: FormData) => {
    if (loading) return;
    setLoading(true);
    setStage("authenticating");
    setApiError("");

    const mobile = data.phone.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) {
      setApiError("Please enter a valid 10-digit mobile number.");
      setLoading(false);
      setStage("input");
      return;
    }

    const verifiedAuth: AuthState = { mobile, sessionId: crypto.randomUUID() };
    setAuthData(verifiedAuth);
    // No profile fetch (PII stays server-side); mark ready so the summary stage renders.
    setProfileData({ ready: true });

    setStage("fetching-profile");
    setLoading(false);
    setStage("gliding");
  };

  const isPostInput = stage === "gliding" || stage === "typing-summary" || stage === "personalized-summary";

  return (
    <div className={cn(
      "flex h-dvh flex-col items-center bg-[#f8f9fa] dark:bg-[#131314] px-4 transition-all duration-1000 ease-in-out",
      isPostInput ? "justify-start pt-[12vh]" : "justify-center pb-[10vh]"
    )}>
      <div className="w-full max-w-3xl flex flex-col justify-start animate-in fade-in slide-in-from-bottom-6 duration-[1200ms] ease-out">

        <div className="mb-8 w-full">
          <div className="min-h-[6rem] sm:min-h-[8rem] flex flex-col items-center text-center gap-4 sm:gap-5 w-full mx-auto">
            <div className={cn(
              "relative shrink-0 transition-all duration-700 ease-out",
              stage === "thinking" ? "opacity-60 scale-90" : "opacity-100 scale-100"
            )}>
              <ZapLogo className="h-5 sm:h-6 w-auto text-[#1f1f1f] dark:text-[#e3e3e3]" />
              {(stage === "thinking" || stage === "authenticating" || stage === "fetching-profile") && (
                <div className="absolute inset-0 animate-ping bg-blue-400/20 rounded-lg" />
              )}
            </div>
            
            <div className="w-full max-w-2xl px-2 transition-all duration-700 ease-in-out">
              {stage === "thinking" ? (
                <p className="text-3xl text-[#70757a] sm:text-4xl dark:text-[#9aa0a6] leading-[1.3] tracking-tight animate-pulse font-medium mx-auto">
                  Connecting...
                </p>
              ) : stage === "authenticating" || stage === "fetching-profile" ? (
                <p className="text-3xl text-[#70757a] sm:text-4xl dark:text-[#9aa0a6] leading-[1.3] tracking-tight animate-pulse font-medium mx-auto">
                  {stage === "authenticating" ? "Verifying mobile..." : "Analyzing financial footprint..."}
                </p>
              ) : (
                <p className="text-3xl text-black sm:text-4xl dark:text-white leading-[1.3] tracking-tight mx-auto">
                  <span className="text-[#1f1f1f] dark:text-[#e3e3e3]">
                    {displayedText}
                  </span>
                  {(stage === "typing" || stage === "input" || stage === "typing-summary" || (stage === "personalized-summary" && displayedText.length > 0)) && (
                    <span className="ml-2 animate-pulse inline-block font-sans align-middle text-[0.5em]">
                      ●
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Input Form Stage */}
        {(stage === "input" || stage === "authenticating") && (
          <div className={cn(
            "flex flex-col items-center transition-all duration-700 ease-out",
            showInput
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-6"
          )}>
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="flex flex-col items-start space-y-4 w-full max-w-md mt-8 mx-auto"
            >
              <div className="flex flex-col items-start w-full">
                <label htmlFor={inputId} className="text-left mb-1.5 text-sm font-medium text-[#444746] dark:text-[#e3e3e3]">
                  Phone Number
                </label>
                <div className="relative w-full flex items-center">
                  <Controller
                    name="phone"
                    control={control}
                    render={({ field }) => (
                      <PhoneInput
                        {...field}
                        id={inputId}
                        country="IN"
                        placeholder="Enter a phone number"
                        disabled={loading}
                        className="w-full bg-white dark:bg-[#0a0a0a] border-[#e5e7eb] dark:border-[#333]"
                      />
                    )}
                  />
                  {loading && (
                    <div className="absolute right-3">
                      <Loader2 className="h-4 w-4 animate-spin text-[#70757a]" />
                    </div>
                  )}
                </div>
                {errors.phone ? (
                  <p className="text-red-500 text-sm mt-1.5 font-medium animate-in fade-in">
                    {errors.phone.message}
                  </p>
                ) : apiError ? (
                  <p className="text-red-500 text-sm mt-1.5 font-medium animate-in fade-in">
                    {apiError}
                  </p>
                ) : null}
              </div>
              <button type="submit" className="hidden" disabled={!phoneValue || loading || !!errors.phone} aria-hidden="true" />
            </form>
            {!apiError && !errors.phone && (
              <p className={cn(
                "mt-4 text-[#70757a] text-xs dark:text-[#9aa0a6] text-center w-full transition-opacity duration-1000 delay-300",
                showInput ? "opacity-100" : "opacity-0"
              )}>
                Press Enter to submit. Your data is securely processed.
              </p>
            )}
          </div>
        )}

        {/* Personalized Summary Stage */}
        {stage === "personalized-summary" && profileData && (
          <div className="w-full max-w-2xl mx-auto mt-4 pl-1 flex flex-col justify-center min-h-[16rem]">

            <div className={cn(
              "flex flex-col items-center justify-center transition-all duration-1000 ease-in-out w-full",
              msg2Started ? "gap-6 translate-y-0" : "gap-0 translate-y-8"
            )}>

              <div className="flex items-start gap-4 w-full">
                <div className="mt-1 shrink-0"><ZapIcon className="size-4 text-[#1f1f1f] dark:text-[#e3e3e3]" /></div>
                <div className="flex-1">
                  <p className="text-[15px] text-[#1f1f1f] dark:text-white/90 leading-relaxed">
                    {msg1Displayed}
                    {(!msg1Finished && msg1Displayed.length > 0) && (
                      <span className="ml-1 animate-pulse inline-block font-sans align-middle text-[0.5em]">●</span>
                    )}
                  </p>
                </div>
              </div>

              {msg2Started && (
                <div className="flex items-start gap-4 w-full animate-in fade-in slide-in-from-bottom-4 duration-700">
                  <div className="mt-1 shrink-0"><ZapIcon className="size-4 opacity-0" /></div>
                  <div className="flex-1">
                    <p className="text-[15px] text-[#1f1f1f] dark:text-white/90 leading-relaxed">
                      {msg2Displayed}
                      {(msg2Displayed.length < msg2Full.length && msg2Displayed.length > 0) && (
                        <span className="ml-1 animate-pulse inline-block font-sans align-middle text-[0.5em]">●</span>
                      )}
                    </p>
                  </div>
                </div>
              )}

            </div>

          </div>
        )}

      </div>
    </div>
  );
}
