import React from 'react';
import { cn, type ClassValue } from './cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:ring-indigo-400 focus-visible:ring-offset-white',
  secondary:
    'bg-white text-zinc-900 border border-zinc-200 hover:bg-zinc-50 focus-visible:ring-indigo-400 focus-visible:ring-offset-white',
  ghost:
    'bg-transparent text-zinc-700 hover:bg-zinc-100 focus-visible:ring-indigo-400 focus-visible:ring-offset-white',
  destructive:
    'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-400 focus-visible:ring-offset-white disabled:opacity-50',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-10 px-4 rounded-xl text-sm',
  md: 'h-12 px-5 rounded-2xl text-sm',
  lg: 'h-14 px-6 rounded-[2rem] text-base',
  icon: 'h-10 w-10 rounded-xl',
};

export const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(
  {
    className,
    variant = 'primary',
    size = 'md',
    leftIcon,
    rightIcon,
    children,
    disabled,
    ...props
  },
  ref
) {
  const isIcon = size === 'icon' && !children;

  return (
    <button
      ref={ref}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-bold transition-all active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100 disabled:pointer-events-none',
        isIcon ? 'p-0' : '',
        sizeClasses[size],
        variantClasses[variant],
        className as ClassValue
      )}
      {...props}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
