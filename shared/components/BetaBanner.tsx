"use client";

import { useState } from "react";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="relative w-full bg-amber-400 text-amber-950 text-xs text-center py-1 px-8 z-50">
      <span>
        Certain features may be limited in Beta.{" "}
        If you encounter any issues, contact us at{" "}
        <a
          href="mailto:company@voste.in"
          className="underline font-semibold hover:text-amber-800"
        >
          company@voste.in
        </a>
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-amber-800 hover:text-amber-950 text-sm leading-none"
        aria-label="Dismiss beta banner"
      >
        ✕
      </button>
    </div>
  );
}
