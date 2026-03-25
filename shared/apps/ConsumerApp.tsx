import React, { useState, useRef, useMemo, Suspense } from 'react';
import { useAuth } from '../context/AuthContext';
import { CartProvider } from '../context/CartContext';
import { ChatProvider } from '../context/ChatContext';
import { NotificationProvider } from '../context/NotificationContext';
import { ToastProvider } from '../context/ToastContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PortalGuard } from '../components/PortalGuard';
import { MobileTabBar } from '../components/MobileTabBar';
import { Button, Card, CardContent } from '../components/ui';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { AuthScreen } from '../pages/Auth';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { Package, User, LogOut, Home as HomeIcon, Bot } from 'lucide-react';
import { lazyRetry } from '../utils/lazyRetry';

const Home = lazyRetry(() => import('../pages/Home').then(m => ({ default: m.Home })));
const Explore = lazyRetry(() => import('../pages/Explore').then(m => ({ default: m.Explore })));
const Orders = lazyRetry(() => import('../pages/Orders').then(m => ({ default: m.Orders })));
const Profile = lazyRetry(() => import('../pages/Profile').then(m => ({ default: m.Profile })));

function TabSkeleton() {
  return <PageSkeleton variant="cards" />;
}

interface ConsumerAppProps {
  onBack?: () => void;
}

export const ConsumerApp: React.FC<ConsumerAppProps> = ({ onBack }) => {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<'home' | 'explore' | 'orders' | 'profile'>('explore');
  const [_slideDir, setSlideDir] = useState<'left' | 'right'>('right');
  const prevTabIdx = useRef(0);

  const TAB_ORDER = ['explore', 'home', 'orders', 'profile'] as const;

  const handleTabChange = (tab: typeof activeTab) => {
    const newIdx = TAB_ORDER.indexOf(tab);
    const oldIdx = TAB_ORDER.indexOf(activeTab);
    setSlideDir(newIdx > oldIdx ? 'left' : 'right');
    prevTabIdx.current = oldIdx;
    setActiveTab(tab);
  };

  const swipeHandlers = useSwipeTabs({
    tabs: TAB_ORDER as unknown as string[],
    activeTab,
    onChangeTab: (t) => handleTabChange(t as typeof activeTab),
  });

  const tabItems = useMemo(() => [
    { id: 'explore', label: 'Home', ariaLabel: 'Home', icon: <HomeIcon size={22} strokeWidth={2.5} /> },
    { id: 'home', label: 'Chat', ariaLabel: 'Chat', icon: <Bot size={22} strokeWidth={2.5} /> },
    { id: 'orders', label: 'Orders', ariaLabel: 'Orders', icon: <Package size={22} strokeWidth={2.5} /> },
    { id: 'profile', label: 'Profile', ariaLabel: 'Profile', icon: <User size={22} strokeWidth={2.5} /> },
  ], []);

  if (!user) return <AuthScreen onBack={onBack} />;

  if (user.role !== 'user') {
    return (
      <PortalGuard
        actualRole={user.role}
        expectedRoleLabel="Buyer App"
        onLogout={logout}
        onBack={onBack}
      />
    );
  }

  if (user.isVerifiedByMediator === false) {
    return (
      <div className="min-h-screen w-full bg-slate-50 relative p-8 flex flex-col items-center justify-center text-center overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1/2 bg-gradient-to-b from-indigo-50 to-transparent pointer-events-none" />
        <div className="w-full max-w-sm relative z-10">
          <Card className="shadow-xl border-indigo-50">
            <CardContent className="p-8">
              <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mb-6 mx-auto">
                <div className="w-3 h-3 bg-indigo-600 rounded-full animate-ping motion-reduce:animate-none" />
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2 tracking-tight">
                Hang Tight!
              </h1>
              <p className="text-slate-500 mb-8 font-medium">
                Your request is with Mediator{' '}
                <span className="text-indigo-600 font-bold font-mono bg-indigo-50 px-2 py-0.5 rounded">
                  {user.mediatorCode}
                </span>
                .
              </p>
              <div className="space-y-3">
                <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 w-[60%]" />
                </div>
                <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">
                  Verification in Progress
                </p>
              </div>

              <Button
                onClick={logout}
                variant="ghost"
                className="mt-8 w-full text-slate-600 hover:bg-slate-100"
                leftIcon={<LogOut size={16} />}
              >
                Cancel Request
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <CartProvider>
          <ChatProvider>
            <NotificationProvider>
            <div className="flex flex-col h-full bg-[#F2F2F7] relative overflow-hidden font-sans">
              <div className="flex-1 overflow-hidden overscroll-none" {...swipeHandlers}>
                <Suspense fallback={<TabSkeleton />}>
                  <div className={`h-full ${activeTab === 'explore' ? '' : 'hidden'}`}>
                    <div className="h-full overflow-y-auto scrollbar-styled"><Explore isActive={activeTab === 'explore'} /></div>
                  </div>
                  <div className={`h-full ${activeTab === 'home' ? '' : 'hidden'}`}>
                    <div className="h-full overflow-y-auto scrollbar-styled"><Home onVoiceNavigate={handleTabChange} /></div>
                  </div>
                  <div className={`h-full ${activeTab === 'orders' ? '' : 'hidden'}`}>
                    <div className="h-full overflow-y-auto scrollbar-styled"><Orders isActive={activeTab === 'orders'} /></div>
                  </div>
                  <div className={`h-full ${activeTab === 'profile' ? '' : 'hidden'}`}>
                    <div className="h-full overflow-y-auto scrollbar-styled"><Profile isActive={activeTab === 'profile'} /></div>
                  </div>
                </Suspense>
              </div>

              <div className="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-[360px]">
                <MobileTabBar
                  items={tabItems}
                  activeId={activeTab}
                  onChange={(id) => handleTabChange(id as any)}
                  variant="glass"
                  showLabels={false}
                />
              </div>
            </div>
          </NotificationProvider>
        </ChatProvider>
      </CartProvider>
    </ToastProvider>
  </ErrorBoundary>
  );
};
