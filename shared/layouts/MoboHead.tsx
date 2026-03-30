import React from 'react';

/**
 * MoboHead — shared <head> meta tags for all MOBO apps.
 * Fonts are now handled by next/font in each app's layout.tsx.
 * Global styles are in each app's globals.css.
 * PWA meta (theme-color, mobile-web-app-capable, apple-*) are
 * set per-app in layout.tsx to avoid duplicate tags.
 */
export function MoboHead() {
  return (
    <>
      <meta charSet="UTF-8" />
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover"
      />
    </>
  );
}
