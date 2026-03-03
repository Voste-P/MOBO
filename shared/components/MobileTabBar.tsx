import React from 'react';
import { cn } from './ui/cn';

type TabId = string;

export type MobileTabBarItem = {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  ariaLabel?: string;
};

export const MobileTabBar = React.memo(function MobileTabBar({
  items,
  activeId,
  onChange,
  variant = 'glass',
  showLabels = false,
  className,
}: {
  items: MobileTabBarItem[];
  activeId: TabId;
  onChange: (id: TabId) => void;
  variant?: 'glass' | 'dark' | 'darkGlass';
  showLabels?: boolean;
  className?: string;
}) {
  const containerClass =
    variant === 'dark'
      ? 'bg-[#18181B] backdrop-blur-xl border border-white/5 px-5 py-2.5 rounded-[2rem] shadow-[0_20px_40px_-10px_rgba(0,0,0,0.5)] flex items-center'
      : variant === 'darkGlass'
        ? 'bg-[#18181B]/90 backdrop-blur-xl border border-white/10 px-6 py-3 rounded-full flex items-center shadow-2xl'
        : 'glass px-6 py-3 rounded-full flex items-center shadow-2xl border border-white/40';

  const ringOffsetClass = variant === 'glass' ? 'focus-visible:ring-offset-[#F2F2F7]' : 'focus-visible:ring-offset-[#18181B]';

  return (
    <div role="tablist" className={cn(containerClass, className)}>
      {items.map((item) => {
        const active = item.id === activeId;

        if (showLabels) {
          return (
            <button
              role="tab"
              key={item.id}
              onClick={() => onChange(item.id)}
              aria-label={item.ariaLabel || item.label}
              aria-selected={active}
              className={cn(
                'flex flex-col items-center gap-1 min-w-[50px] transition-all duration-300 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#18181B] rounded-xl motion-reduce:transition-none motion-reduce:transform-none',
                active ? '-translate-y-1' : 'hover:-translate-y-0.5'
              )}
              type="button"
            >
              <div
                className={cn(
                  'p-2.5 rounded-[1rem] transition-all relative',
                  active
                    ? 'bg-indigo-500 text-white shadow-[0_6px_18px_-8px_rgba(99,102,241,0.65)] scale-105'
                    : 'bg-transparent text-zinc-500 hover:text-zinc-300'
                )}
              >
                {item.icon}
                {(item.badge ?? 0) > 0 ? (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border border-[#18181B]">
                    {item.badge}
                  </span>
                ) : null}
              </div>
              <span
                className={cn(
                  'text-[9px] font-bold tracking-wide transition-all duration-300',
                  active
                    ? 'text-indigo-300 opacity-100'
                    : 'text-zinc-500 opacity-0 scale-0 group-hover:opacity-100 group-hover:scale-100'
                )}
              >
                {item.label}
              </span>
            </button>
          );
        }

        return (
          <div key={item.id} className="flex-1 flex justify-center">
            <button
              role="tab"
              onClick={() => onChange(item.id)}
              aria-label={item.ariaLabel || item.label}
              aria-selected={active}
              className={cn(
                'relative p-3 rounded-full transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:transform-none',
                ringOffsetClass,
                active
                  ? variant === 'darkGlass'
                    ? 'bg-[#CCF381] text-black shadow-lg scale-110'
                    : 'bg-indigo-600 text-white shadow-lg scale-110'
                  : variant === 'darkGlass'
                    ? 'text-white/60 hover:text-white/85'
                    : 'text-slate-400 hover:text-slate-600'
              )}
              type="button"
            >
              <span className="sr-only">{item.label}</span>
              {item.icon}
              {(item.badge ?? 0) > 0 ? (
                <span
                  className={cn(
                    'absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2',
                    variant === 'darkGlass' ? 'border-[#18181B]' : 'border-white'
                  )}
                ></span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
});
MobileTabBar.displayName = 'MobileTabBar';
