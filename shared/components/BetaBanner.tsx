"use client";

import { useState, useEffect } from "react";

const DISMISS_KEY = "mobo_beta_dismissed";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* quota */ }
  };

  if (dismissed) return null;

  return (
    <div role="banner" className="w-full bg-yellow-50 border-b border-yellow-300 text-yellow-900 z-50 px-3 py-1.5">
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-px font-extrabold tracking-wider text-[9px] sm:text-[10px] bg-yellow-400 text-yellow-950 px-1.5 py-0.5 rounded leading-none uppercase select-none animate-beta-pulse motion-reduce:animate-none">
          Beta
        </span>
        <p className="flex-1 min-w-0 text-[10px] sm:text-xs leading-snug">
          Some features may be limited during beta.
          Report issues via <strong>Tickets</strong> or{" "}
          <a href="mailto:company@voste.in" className="underline font-semibold hover:text-yellow-700 transition-colors">company@voste.in</a>
        </p>
        <button
          onClick={handleDismiss}
          className="shrink-0 mt-px text-yellow-500 hover:text-yellow-800 text-xs leading-none transition-colors"
          aria-label="Dismiss beta banner"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
