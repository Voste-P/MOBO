import React from 'react';
import { cn } from './cn';

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center py-14 px-6 bg-white rounded-[1.5rem] border border-dashed border-zinc-200 animate-enter',
        className
      )}
    >
      {icon ? <div className="mb-4 opacity-70">{icon}</div> : null}
      <div className="text-sm font-extrabold text-zinc-900">{title}</div>
      {description ? <div className="mt-1 text-xs font-medium text-zinc-500 max-w-sm">{description}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
