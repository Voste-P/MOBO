'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; error: Error | null; retryCount: number; reloading: boolean };

/** Maximum retries before showing a persistent "contact support" message. */
const MAX_RETRIES = 3;

/**
 * Global React error boundary.
 * Catches unhandled render errors so the entire app doesn't crash.
 * Tracks retry count - after MAX_RETRIES, forces a hard page reload.
 * Reports errors to backend for production monitoring.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0, reloading: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
    // Report to backend for production monitoring (fire-and-forget)
    this.reportErrorToBackend(error, info.componentStack || '');
  }

  private reportErrorToBackend(error: Error, componentStack: string) {
    try {
      const apiUrl = typeof window !== 'undefined'
        ? (window as any).__NEXT_DATA__?.runtimeConfig?.apiUrl || process.env.NEXT_PUBLIC_API_URL || ''
        : '';
      if (!apiUrl) return;
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`${apiUrl}/api/health/client-error`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: error.message?.slice(0, 500),
          stack: error.stack?.slice(0, 1000),
          componentStack: componentStack?.slice(0, 500),
          url: typeof window !== 'undefined' ? window.location.href : '',
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => { /* silent — error reporting must never break the app */ });
    } catch { /* safety net */ }
  }

  private handleReload = () => {
    const nextCount = this.state.retryCount + 1;
    if (nextCount >= MAX_RETRIES) {
      this.setState({ reloading: true });
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null, retryCount: nextCount });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const exhausted = this.state.retryCount >= MAX_RETRIES - 1;
      const isNetworkError = this.state.error?.message?.toLowerCase().includes('fetch')
        || this.state.error?.message?.toLowerCase().includes('network')
        || this.state.error?.message?.toLowerCase().includes('failed to load');

      return (
        <div className="min-h-[100dvh] flex flex-col items-center justify-center p-6 sm:p-8 font-sans text-center bg-slate-50" role="alert">
          <div className="text-4xl sm:text-5xl mb-4" aria-hidden="true">⚠️</div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 mb-2">
            Something went wrong
          </h1>
          <p className="text-sm text-slate-500 mb-6 max-w-sm leading-relaxed">
            {exhausted
              ? 'This error keeps occurring. Please try refreshing the page or contact support if it persists.'
              : isNetworkError
                ? 'Could not connect to the server. Please check your internet connection and try again.'
                : 'An unexpected error occurred. Please reload to continue.'}
          </p>
          {this.state.error && (
            <details className="mb-6 max-w-sm w-full text-left">
              <summary className="text-xs font-bold text-slate-400 cursor-pointer hover:text-slate-600 transition-colors">
                Error details
              </summary>
              <pre className="mt-2 p-3 bg-slate-100 rounded-xl text-[10px] text-slate-600 overflow-auto max-h-32 scrollbar-styled font-mono">
                {this.state.error?.message || 'Unknown error'}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            disabled={this.state.reloading}
            className="px-8 py-3 rounded-xl border-none bg-lime-400 text-lime-950 font-bold text-sm cursor-pointer hover:bg-lime-500 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {this.state.reloading ? 'Reloading…' : exhausted ? 'Force Reload' : 'Reload'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}