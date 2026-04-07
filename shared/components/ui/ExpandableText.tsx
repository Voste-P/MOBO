'use client';

import { useState, type ReactNode } from 'react';

interface ExpandableTextProps {
  text: string | undefined | null;
  /** Tailwind line-clamp class when collapsed, e.g. 'line-clamp-1' or 'line-clamp-2' */
  clampClass?: string;
  /** Additional CSS classes for the wrapper element */
  className?: string;
  /** HTML tag to render — defaults to 'span' */
  as?: 'span' | 'p' | 'h3' | 'h4' | 'div';
  /** Children override — if provided, renders children instead of text */
  children?: ReactNode;
}

/**
 * Click-to-expand wrapper for truncated text.
 * Shows a tooltip on hover when collapsed, expands on click, collapses on second click.
 */
export function ExpandableText({
  text,
  clampClass = 'line-clamp-1',
  className = '',
  as: Tag = 'span',
  children,
}: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);

  const content = children ?? text;
  if (!content) return null;

  return (
    <Tag
      className={`cursor-pointer ${expanded ? '' : clampClass} ${className}`}
      title={expanded ? undefined : (typeof text === 'string' ? text : undefined)}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setExpanded(v => !v); }}
    >
      {content}
    </Tag>
  );
}
