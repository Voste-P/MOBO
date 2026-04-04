'use client';

import React from 'react';
import {
  Smartphone,
  Monitor,
  ShieldCheck,
  ShoppingBag,
  Users,
  Briefcase,
  Building2,
  Lock,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

export const AppSwitchboard: React.FC<{ onSelect: (role: string) => void }> = ({ onSelect }) => (
  <div className="min-h-[100dvh] bg-slate-950 text-white flex flex-col font-sans selection:bg-lime-400 selection:text-black">
    {/* Animated Background */}
    <div className="fixed inset-0 z-0">
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_-20%,theme(colors.indigo.900),transparent)] opacity-40"></div>
      <div className="absolute bottom-0 right-0 w-full h-full bg-[radial-gradient(circle_at_80%_120%,theme(colors.indigo.950),transparent)] opacity-30"></div>
    </div>

    <div className="relative z-10 flex-1 flex flex-col items-center justify-center p-6">
      <header className="text-center mb-16 animate-enter">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-lime-400 text-[10px] font-bold uppercase tracking-widest mb-6">
          <Sparkles size={10} /> Next-Gen Ecosystem
        </div>
        <h1 className="text-6xl md:text-8xl font-black tracking-tighter mb-4">
          BUZZMA<span className="text-lime-400">OS</span>
        </h1>
        <p className="text-slate-400 text-lg md:text-xl font-medium max-w-xl mx-auto leading-relaxed">
          A unified commerce framework powering global brands, performance agencies, and savvy
          shoppers.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 w-full max-w-7xl px-4">
        <SwitchCard
          title="Shopper"
          desc="Deals & Rewards"
          icon={<ShoppingBag size={28} />}
          type="Mobile"
          color="lime"
          delay={0}
          onClick={() => onSelect('consumer')}
        />
        <SwitchCard
          title="Mediator"
          desc="Manage Buyers & Earn"
          icon={<Users size={28} />}
          type="Mobile"
          color="indigo"
          delay={1}
          onClick={() => onSelect('mediator')}
        />
        <SwitchCard
          title="Agency"
          desc="Ops & Network Mgmt"
          icon={<Briefcase size={28} />}
          type="Web"
          color="purple"
          delay={2}
          onClick={() => onSelect('agency')}
        />
        <SwitchCard
          title="Brand"
          desc="Inventory & ROI"
          icon={<Building2 size={28} />}
          type="Web"
          color="blue"
          delay={3}
          onClick={() => onSelect('brand')}
        />
        <SwitchCard
          title="Admin"
          desc="Core Oversight"
          icon={<ShieldCheck size={28} />}
          type="Terminal"
          color="rose"
          delay={4}
          onClick={() => onSelect('admin')}
        />
      </div>

      <footer className="mt-20 text-slate-600 text-[10px] font-bold uppercase tracking-[0.3em]">
        BUZZMAOS v1.0 • Unified Commerce Platform
      </footer>
    </div>
  </div>
);

const SwitchCard = ({ title, desc, icon, type, color, delay = 0, onClick }: { title: string; desc: string; icon: React.ReactNode; type: string; color: string; delay?: number; onClick: () => void }) => {
  const colors: Record<string, string> = {
    lime: 'hover:border-lime-500/50 hover:shadow-lime-500/20 hover:shadow-lg text-lime-400',
    indigo: 'hover:border-indigo-500/50 hover:shadow-indigo-500/20 hover:shadow-lg text-indigo-400',
    purple: 'hover:border-purple-500/50 hover:shadow-purple-500/20 hover:shadow-lg text-purple-400',
    blue: 'hover:border-blue-500/50 hover:shadow-blue-500/20 hover:shadow-lg text-blue-400',
    rose: 'hover:border-rose-500/50 hover:shadow-rose-500/20 hover:shadow-lg text-rose-400',
  };

  return (
    <button
      onClick={onClick}
      style={{ animationDelay: `${delay * 80}ms`, animationFillMode: 'both' }}
      className={`group animate-enter bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8 text-center flex flex-col items-center transition-all duration-500 hover:-translate-y-2 ${colors[color]}`}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 mb-6 group-hover:text-white transition-colors">
        {type === 'Mobile' ? (
          <Smartphone size={10} />
        ) : type === 'Web' ? (
          <Monitor size={10} />
        ) : (
          <Lock size={10} />
        )}{' '}
        {type}
      </div>
      <div className="w-16 h-16 bg-white/5 rounded-3xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-white group-hover:text-black transition-all duration-500">
        {icon}
      </div>
      <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
      <p className="text-xs text-slate-500 leading-relaxed font-medium mb-8">{desc}</p>
      <div className="mt-auto flex items-center gap-2 text-[10px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
        Enter <ArrowRight size={12} />
      </div>
    </button>
  );
};
