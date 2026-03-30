import React from 'react';
import { Package } from 'lucide-react';

export const Navbar: React.FC = React.memo(() => {
  return (
    <nav className="flex-none bg-white/80 backdrop-blur-md border-b border-gray-100 z-30 sticky top-0 safe-top">
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
