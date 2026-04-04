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

  // Keep --banner-h CSS variable in sync so auth pages can account for the spacer
  useEffect(() => {
    document.documentElement.style.setProperty('--banner-h', dismissed ? '0px' : '34px');
  }, [dismissed]);

  const handleDismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* quota */ }
  };

  if (dismissed) return null;

  return (
    <>
      {/* Fixed banner at top so it never pushes content off-screen */}
      <div className="fixed top-0 left-0 right-0 bg-yellow-50 border-b border-yellow-300 text-yellow-900 z-banner px-3 py-1.5">
        <div className="flex items-start gap-2">
          <span className="shrink-0 mt-px font-extrabold tracking-wider text-[9px] sm:text-[10px] bg-yellow-400 text-yellow-950 px-1.5 py-0.5 rounded leading-none uppercase select-none animate-beta-pulse">
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
        <style>{`
          @keyframes beta-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0.7); transform: scale(1); }
            50% { box-shadow: 0 0 8px 3px rgba(250, 204, 21, 0.45); transform: scale(1.04); }
          }
          .animate-beta-pulse { animation: beta-pulse 2.5s ease-in-out infinite; }
          @media (prefers-reduced-motion: reduce) {
            .animate-beta-pulse { animation: none; }
          }
        `}</style>
      </div>
      {/* Spacer to offset fixed banner height */}
      <div className="h-[34px] shrink-0" aria-hidden="true" />
    </>
  );
}
