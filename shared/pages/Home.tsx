import React, { lazy, Suspense } from 'react';

// Chatbot is 37.6 KB — lazy-load so it doesn't block initial paint
const Chatbot = lazy(() =>
  import('../components/Chatbot').then((mod) => ({ default: mod.Chatbot }))
);

interface HomeProps {
  onVoiceNavigate?: (tab: 'home' | 'explore' | 'orders' | 'profile') => void;
}

export const Home: React.FC<HomeProps> = ({ onVoiceNavigate }) => {
  // Notifications are server-backed; avoid seeded/mock toasts here.
  return (
    <div className="h-full w-full flex flex-col relative bg-[#F4F4F5]">
      <Suspense fallback={
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-3 border-lime-200 border-t-lime-500 rounded-full animate-spin" />
        </div>
      }>
        <Chatbot onNavigate={onVoiceNavigate} />
      </Suspense>
    </div>
  );
};
