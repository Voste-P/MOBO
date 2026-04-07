import React, { Component, lazy, Suspense } from 'react';

// Chatbot is 37.6 KB — lazy-load so it doesn't block initial paint
const Chatbot = lazy(() =>
  import('../components/Chatbot').then((mod) => ({ default: mod.Chatbot }))
);

class ChatbotErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean; retryKey: number }
> {
  state = { hasError: false, retryKey: 0 };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') console.error('[ChatbotErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm font-bold text-zinc-700">Failed to load chat.</p>
          <button
            onClick={() => this.setState((s) => ({ hasError: false, retryKey: s.retryKey + 1 }))}
            className="px-5 py-2.5 bg-black text-white text-sm font-bold rounded-2xl hover:bg-zinc-800 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}

interface HomeProps {
  onVoiceNavigate?: (tab: 'home' | 'explore' | 'orders' | 'profile') => void;
  isActive?: boolean;
}

export const Home: React.FC<HomeProps> = ({ onVoiceNavigate, isActive = true }) => {
  return (
    <div className="h-full w-full flex flex-col relative bg-mobo-dark-100">
      <ChatbotErrorBoundary>
        <Suspense fallback={
          <div className="flex-1 flex items-center justify-center" role="status" aria-label="Loading chat">
            <div className="w-8 h-8 border-2 border-lime-200 border-t-lime-500 rounded-full animate-spin motion-reduce:animate-none" />
          </div>
        }>
          <Chatbot onNavigate={onVoiceNavigate} isActive={isActive} />
        </Suspense>
      </ChatbotErrorBoundary>
    </div>
  );
};
