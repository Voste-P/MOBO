'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { cn } from './cn';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
  variant?: 'pill' | 'underline';
}

export function Tabs({ tabs, activeTab, onTabChange, className, variant = 'pill' }: TabsProps) {
  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let targetIdx = -1;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      targetIdx = (idx + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      targetIdx = (idx - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      targetIdx = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      targetIdx = tabs.length - 1;
    }
    if (targetIdx >= 0) {
      onTabChange(tabs[targetIdx].id);
      const btn = (e.currentTarget.parentElement as HTMLElement)?.querySelectorAll<HTMLElement>('[role="tab"]')?.[targetIdx];
      btn?.focus();
    }
  };

  return (
    <div
      className={cn(
        'flex gap-1 overflow-x-auto scrollbar-hide',
        variant === 'pill' && 'bg-zinc-100 p-1 rounded-2xl',
        variant === 'underline' && 'border-b border-zinc-200',
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab, idx) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              'relative flex items-center gap-1.5 px-4 py-2 text-sm font-bold whitespace-nowrap transition-colors rounded-xl',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/60 focus-visible:ring-offset-1',
              variant === 'pill' && !active && 'text-zinc-500 hover:text-zinc-700',
              variant === 'pill' && active && 'text-zinc-900',
              variant === 'underline' && !active && 'text-zinc-500 hover:text-zinc-700 rounded-none pb-3',
              variant === 'underline' && active && 'text-zinc-900 rounded-none pb-3',
            )}
          >
            {variant === 'pill' && active && (
              <motion.span
                layoutId="tab-pill"
                className="absolute inset-0 bg-white rounded-xl shadow-sm"
                transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
              />
            )}
            {variant === 'underline' && active && (
              <motion.span
                layoutId="tab-underline"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-zinc-900 rounded-full"
                transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {tab.icon}
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="ml-1 min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center bg-lime-400 text-black text-[10px] font-extrabold rounded-full">
                  {tab.badge > 99 ? '99+' : tab.badge}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
