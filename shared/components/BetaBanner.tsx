"use client";

import { useState } from "react";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="w-full bg-amber-50 border-b border-amber-200 text-amber-800 text-[9px] sm:text-[10px] text-center py-px px-7 z-50 flex items-center justify-center gap-1">
      <span className="font-extrabold tracking-wider text-[8px] sm:text-[9px] bg-amber-400 text-amber-950 px-1 py-px rounded leading-none shrink-0">BETA</span>
      <span className="truncate">
        Beta mode &middot; Report issues via <strong>Tickets</strong> or{" "}
        <a href="mailto:company@voste.in" className="underline font-semibold hover:text-amber-600">company@voste.in</a>
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="ml-auto shrink-0 text-amber-400 hover:text-amber-700 text-[9px] leading-none pl-1"
        aria-label="Dismiss beta banner"
      >
        ✕
      </button>
    </div>
  );
}
