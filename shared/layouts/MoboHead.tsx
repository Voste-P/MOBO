import React from 'react';

/**
 * MoboHead — shared <head> meta tags for all MOBO apps.
 * Fonts are now handled by next/font in each app's layout.tsx.
 * Global styles are in each app's globals.css.
 */
export function MoboHead() {
  return (
    <>
      <meta charSet="UTF-8" />
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover"
      />
      <meta name="theme-color" content="#0F172A" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    </>
  );
}
