"use client";

import { useState, useEffect } from "react";

const DISMISS_KEY = "mobo_beta_dismissed";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash

  useEffect(() => {
    // Restore dismiss state from sessionStorage (reappears on new session)
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
    <div className="w-full bg-yellow-50 border-b border-yellow-300 text-yellow-900 text-[10px] sm:text-xs leading-tight z-50 flex items-center gap-2 px-3 py-1.5">
      <span className="shrink-0 font-extrabold tracking-wider text-[9px] sm:text-[10px] bg-yellow-400 text-yellow-950 px-1.5 py-0.5 rounded leading-none uppercase select-none">
        Beta Test
      </span>
      <span className="min-w-0 truncate">
        Certain features are disabled in Beta mode. Report issues via{" "}
        <strong>Tickets</strong> or mail{" "}
        <a href="mailto:company@voste.in" className="underline font-semibold hover:text-yellow-700 transition-colors">company@voste.in</a>
      </span>
      <button
        onClick={handleDismiss}
        className="ml-auto shrink-0 text-yellow-500 hover:text-yellow-800 text-xs leading-none pl-1 transition-colors"
        aria-label="Dismiss beta banner"
      >
        ✕
      </button>
    </div>
  );
}
