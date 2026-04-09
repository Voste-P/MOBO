import React from 'react';
import { Package, Bell } from 'lucide-react';

interface NavbarProps {
  /** Unread notification count to display on bell badge */
  notificationCount?: number;
  /** Callback when notification bell is clicked */
  onNotificationClick?: () => void;
  /** Optional right-side actions slot */
  actions?: React.ReactNode;
}

export const Navbar: React.FC<NavbarProps> = React.memo(({
  notificationCount = 0,
  onNotificationClick,
  actions,
}) => {
  return (
    <nav className="flex-none bg-white/80 backdrop-blur-md border-b border-gray-100 z-30 sticky top-0 safe-top">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-zinc-900 focus:text-white focus:rounded-xl focus:text-sm focus:font-bold">Skip to main content</a>
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        {/* Branding */}
        <div className="flex items-center gap-2">
          <div className="bg-[#CCF381] text-zinc-900 p-1.5 rounded-lg shadow-sm">
            <Package size={20} />
          </div>
          <span className="font-extrabold text-lg tracking-tight text-slate-900">BUZZMA</span>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          {actions}
          {onNotificationClick && (
            <button
              onClick={onNotificationClick}
              className="relative w-11 h-11 flex items-center justify-center rounded-full hover:bg-zinc-100 active:bg-zinc-200 transition-colors text-zinc-600"
              aria-label={notificationCount > 0 ? `${notificationCount} unread notifications` : 'Notifications'}
            >
              <Bell size={20} strokeWidth={2} />
              {notificationCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[18px] h-[18px] flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full px-1 animate-scale-in">
                  {notificationCount > 99 ? '99+' : notificationCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </nav>
  );
});
Navbar.displayName = 'Navbar';
