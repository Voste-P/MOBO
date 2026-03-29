import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';
import { MoboHead } from '../../../shared/layouts/MoboHead';
import { BODY_CLASSNAME, HTML_CLASSNAME } from '../../../shared/styles/moboGlobals';
import { DisableNumberScroll } from '../../../shared/components/DisableNumberScroll';
import { plusJakartaSans, jetbrainsMono } from '../../../shared/fonts';
import { BetaBanner } from '../../../shared/components/BetaBanner';

export const metadata: Metadata = {
  title: 'BUZZMA Agency',
  description: 'Agency portal for managing mediators, campaigns, deals, and ops workflows.',
  robots: { index: false, follow: false },
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${HTML_CLASSNAME} ${plusJakartaSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <MoboHead />
        <meta name="theme-color" content="#A3E635" />
        <meta name="application-name" content="BUZZMA Agency" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="BUZZMA Agency" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className={BODY_CLASSNAME} suppressHydrationWarning>
        <BetaBanner />
        <DisableNumberScroll />
        {children}
      </body>
    </html>
  );
}
