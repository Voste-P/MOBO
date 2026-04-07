'use client';
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const variants = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  slideUp: {
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -16 },
  },
  slideRight: {
    initial: { opacity: 0, x: 40 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -40 },
  },
  scale: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.97 },
  },
} as const;

type AnimationVariant = keyof typeof variants;

interface AnimatedViewProps {
  children: React.ReactNode;
  viewKey: string;
  variant?: AnimationVariant;
  className?: string;
  duration?: number;
}

/** Wrap conditional renders for smooth animated transitions between views */
export function AnimatedView({
  children,
  viewKey,
  variant = 'slideUp',
  className,
  duration = 0.3,
}: AnimatedViewProps) {
  const v = variants[variant];
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={viewKey}
        initial={v.initial}
        animate={v.animate}
        exit={v.exit}
        transition={{ duration, ease: [0.25, 0.46, 0.45, 0.94] }}
        className={className}
        style={{ display: 'contents' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Stagger children entrance one by one */
export function StaggerContainer({
  children,
  className,
  stagger = 0.06,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{
        visible: { transition: { staggerChildren: stagger } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
      }}
    >
      {children}
    </motion.div>
  );
}
