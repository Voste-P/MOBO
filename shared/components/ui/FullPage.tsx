import React from 'react';
import { Card, CardContent } from './Card';
import { Spinner } from './Spinner';
import { Button } from './Button';
import { cn } from './cn';

export function FullPageLoading({
  title = 'Loading…',
  description = 'Just a moment.',
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'min-h-screen w-full bg-slate-50 flex items-center justify-center p-6',
        className
      )}
    >
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          <div className="flex items-center gap-3">
            <Spinner className="w-5 h-5 text-slate-900" />
            <div>
              <div className="text-sm font-extrabold text-slate-900">{title}</div>
              <div className="text-xs font-medium text-slate-500">{description}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function FullPageError({
  title = 'Something went wrong',
  description = 'Please try again.',
  details,
  actionLabel = 'Try again',
  onAction,
  className,
}: {
  title?: string;
  description?: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  // In production, never expose raw error messages — they may contain stack traces,
  // database errors, or internal implementation details.
  const isProd = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  const safeDetails = isProd ? undefined : details;

  return (
    <div
      className={cn(
        'min-h-screen w-full bg-slate-50 flex items-center justify-center p-6',
        className
      )}
    >
      <Card className="w-full max-w-lg">
        <CardContent className="p-8">
          <div className="text-lg font-extrabold text-slate-900">{title}</div>
          <div className="mt-1 text-sm font-medium text-slate-600">{description}</div>
          {safeDetails ? (
            <pre className="mt-4 text-xs bg-slate-100 border border-slate-200 rounded-xl p-3 overflow-auto scrollbar-styled text-slate-700 max-h-40">
              {safeDetails}
            </pre>
          ) : null}
          {onAction ? (
            <div className="mt-6">
              <Button onClick={onAction} variant="primary">
                {actionLabel}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function FullPageNotFound({
  appName = 'App',
  title = 'Page not found',
  description,
  homeHref = '/',
  homeLabel = 'Go home',
  className,
}: {
  appName?: string;
  title?: string;
  description?: string;
  homeHref?: string;
  homeLabel?: string;
  className?: string;
}) {
  const desc =
    typeof description === 'string' && description.trim()
      ? description
      : `This ${appName} page doesn’t exist or was moved.`;

  return (
    <div
      className={cn(
        'min-h-screen w-full bg-slate-50 flex items-center justify-center p-6',
        className
      )}
    >
      <Card className="w-full max-w-lg">
        <CardContent className="p-8">
          <div className="text-lg font-extrabold text-slate-900">{title}</div>
          <div className="mt-1 text-sm font-medium text-slate-600">{desc}</div>
          <div className="mt-6">
            <a
              href={homeHref}
              className="inline-flex items-center justify-center h-12 px-5 rounded-2xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-400/60 focus-visible:ring-offset-white"
            >
              {homeLabel}
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
