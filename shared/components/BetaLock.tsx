import React from 'react';
import { Lock } from 'lucide-react';

/** Toggle this to false when payments go live */
export const BETA_PAYMENTS_LOCKED = true;

/**
 * Overlay that blocks payment-related interactions during beta.
 * Wrap any payment section with <BetaLock>...</BetaLock>.
 * When BETA_PAYMENTS_LOCKED is false, children render normally with no overlay.
 */
export const BetaLock: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => {
  if (!BETA_PAYMENTS_LOCKED) return <>{children}</>;
  return (
    <div className={`relative ${className}`}>
      <div className="pointer-events-none select-none opacity-40 blur-[1px]">
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 backdrop-blur-[2px] rounded-[inherit] z-10">
        <div className="flex flex-col items-center gap-2 px-4 py-3 bg-white border border-zinc-200 rounded-2xl shadow-lg">
          <Lock size={20} className="text-zinc-400" />
          <p className="text-xs font-bold text-zinc-600">Locked during Beta</p>
          <p className="text-[10px] text-zinc-400 text-center max-w-[180px]">Payments & payouts will be available after beta testing.</p>
        </div>
      </div>
    </div>
  );
};
