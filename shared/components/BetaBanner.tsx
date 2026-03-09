"use client";

import { useState } from "react";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="relative w-full bg-amber-50 border-b border-amber-200 text-amber-800 text-[10px] sm:text-[11px] text-center py-0.5 px-6 z-50 flex items-center justify-center gap-1.5">
      <span className="inline-flex items-center gap-1.5">
        <span className="font-extrabold tracking-wider text-[9px] sm:text-[10px] bg-amber-400 text-amber-950 px-1.5 py-px rounded">BETA</span>
        <span>
          Certain features are disabled in Beta mode. If you encounter any issues, report via{" "}
          <strong>Tickets</strong> or contact{" "}
          <a
            href="mailto:company@voste.in"
            className="underline font-semibold hover:text-amber-600"
          >
            company@voste.in
          </a>
        </span>
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-amber-400 hover:text-amber-700 text-[10px] leading-none"
        aria-label="Dismiss beta banner"
      >
        ✕
      </button>
    </div>
  );
}
