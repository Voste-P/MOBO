import React from 'react';

export type SidebarTheme = 'admin' | 'agency' | 'brand';

interface SidebarItemProps {
  /** Lucide icon — either a component (e.g. `LayoutGrid`) or element (e.g. `<LayoutGrid />`) */
  icon: React.ReactElement | React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  theme?: SidebarTheme;
}

const themes: Record<SidebarTheme, {
  ring: string;
  active: string;
  inactive: string;
  indicator: string;
  iconActive: string;
  iconInactive: string;
  badgeActive: string;
  badgeInactive: string;
}> = {
  admin: {
    ring: 'focus-visible:ring-zinc-400 focus-visible:ring-offset-slate-950',
    active: 'bg-white/10 text-white shadow-lg backdrop-blur-sm border border-white/5',
    inactive: 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
    indicator: 'bg-lime-500',
    iconActive: 'text-lime-400',
    iconInactive: 'text-slate-500 group-hover:text-slate-300',
    badgeActive: 'bg-zinc-700 text-white',
    badgeInactive: 'bg-zinc-700 text-white',
  },
  agency: {
    ring: 'focus-visible:ring-purple-300 focus-visible:ring-offset-white',
    active: 'bg-purple-600 text-white shadow-lg shadow-purple-200',
    inactive: 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
    indicator: 'bg-purple-500',
    iconActive: 'text-white',
    iconInactive: 'text-slate-400 group-hover:text-slate-600',
    badgeActive: 'bg-white text-purple-600',
    badgeInactive: 'bg-purple-100 text-purple-600',
  },
  brand: {
    ring: 'focus-visible:ring-lime-300 focus-visible:ring-offset-white',
    active: 'bg-zinc-900 text-white shadow-xl shadow-zinc-900/10',
    inactive: 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900',
    indicator: 'bg-lime-400',
    iconActive: 'text-lime-400',
    iconInactive: 'group-hover:text-zinc-900',
    badgeActive: 'bg-lime-500 text-zinc-900',
    badgeInactive: 'bg-lime-500 text-zinc-900',
  },
};

export const SidebarItem: React.FC<SidebarItemProps> = ({
  icon,
  label,
  active,
  onClick,
  badge,
  theme = 'admin',
}) => {
  const t = themes[theme];
  const isAdmin = theme === 'admin';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center justify-between ${isAdmin ? 'px-4 py-3' : 'px-5 py-4'} ${isAdmin ? 'rounded-xl' : 'rounded-2xl'} transition-colors duration-200 group relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 ${t.ring} motion-reduce:transition-none motion-reduce:transform-none ${
        active ? t.active : t.inactive
      } ${!isAdmin ? 'mb-1' : ''}`}
    >
      {isAdmin && active && (
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${t.indicator} rounded-r-full`} />
      )}
      <div className={`flex items-center ${isAdmin ? 'gap-3' : 'gap-4'} min-w-0 flex-1`}>
        <span className={`transition-colors flex-shrink-0 ${active ? t.iconActive : t.iconInactive}`}>
          {React.isValidElement(icon)
            ? React.cloneElement(icon as React.ReactElement<Record<string, unknown>>, {
                size: isAdmin ? 18 : 20,
                strokeWidth: active ? 2.5 : 2,
              })
            : React.createElement(icon as React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>, {
                size: isAdmin ? 18 : 20,
                strokeWidth: active ? 2.5 : 2,
              })}
        </span>
        <span
          className={`${isAdmin ? 'text-sm' : 'text-[15px]'} tracking-wide whitespace-nowrap truncate ${
            active ? 'font-bold' : 'font-medium'
          }`}
        >
          {label}
        </span>
      </div>
      {(badge ?? 0) > 0 && (
        <span
          className={`text-[10px] font-bold min-w-[20px] px-1.5 py-0.5 rounded-full shadow-sm flex-shrink-0 ml-2 text-center ${
            active ? t.badgeActive : t.badgeInactive
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
};
