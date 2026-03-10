import React from 'react';
import { cn } from './cn';

type CardVariant = 'default' | 'elevated' | 'outlined' | 'filled';
type Props = React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant; interactive?: boolean };

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-white border border-zinc-100 shadow-sm',
  elevated: 'bg-white border border-zinc-100 shadow-lg',
  outlined: 'bg-transparent border border-zinc-200',
  filled: 'bg-zinc-50 border border-zinc-100',
};

export function Card({ className, variant = 'default', interactive, ...props }: Props) {
  return (
    <div
      className={cn(
        'rounded-[2rem]',
        variantClasses[variant],
        interactive && 'cursor-pointer hover:shadow-md transition-shadow',
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: Props) {
  return <div className={cn('p-6 pb-0', className)} {...props} />;
}

export function CardContent({ className, ...props }: Props) {
  return <div className={cn('p-6', className)} {...props} />;
}
