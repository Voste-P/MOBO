'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; error: Error | null; retryCount: number };

/** Maximum retries before showing a persistent "contact support" message. */
const MAX_RETRIES = 3;

/**
 * Global React error boundary.
 * Catches unhandled render errors so the entire app doesn't crash.
 * Tracks retry count - after MAX_RETRIES, forces a hard page reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  private handleReload = () => {
    const nextCount = this.state.retryCount + 1;
    if (nextCount >= MAX_RETRIES) {
      // After repeated failures, hard-reload to get fresh JS bundles
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null, retryCount: nextCount });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const exhausted = this.state.retryCount >= MAX_RETRIES - 1;

      return (
        <div className="min-h-[100dvh] flex flex-col items-center justify-center p-8 font-sans text-center bg-slate-50">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">
            Something went wrong
          </h1>
          <p className="text-sm text-slate-500 mb-6 max-w-sm">
            {exhausted
              ? 'This error keeps occurring. Please try refreshing the page or contact support if it persists.'
              : 'An unexpected error occurred. Please reload to continue.'}
          </p>
          {this.state.error && (
            <details className="mb-6 max-w-sm w-full text-left">
              <summary className="text-xs font-bold text-slate-400 cursor-pointer hover:text-slate-600 transition-colors">
                Error details
              </summary>
              <pre className="mt-2 p-3 bg-slate-100 rounded-xl text-[10px] text-slate-600 overflow-auto max-h-32 scrollbar-styled font-mono">
                {this.state.error.message}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="px-8 py-3 rounded-xl border-none bg-lime-400 text-lime-950 font-bold text-sm cursor-pointer hover:bg-lime-500 active:scale-95 transition-all"
          >
            {exhausted ? 'Force Reload' : 'Reload'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}