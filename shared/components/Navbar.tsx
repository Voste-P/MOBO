import React from 'react';
import { Package } from 'lucide-react';

export const Navbar: React.FC = React.memo(() => {
  return (
    <nav className="flex-none bg-white/80 backdrop-blur-md border-b border-gray-100 z-30 sticky top-0 safe-top">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-indigo-600 focus:text-white focus:rounded-xl focus:text-sm focus:font-bold">Skip to main content</a>
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Branding */}
        <div className="flex items-center gap-2">
          <div className="bg-lime-400 text-black p-1.5 rounded-lg shadow-sm">
            <Package size={20} />
          </div>
          <span className="font-extrabold text-xl tracking-tight text-slate-900">BUZZMA</span>
        </div>
      </div>
    </nav>
  );
});
Navbar.displayName = 'Navbar';
