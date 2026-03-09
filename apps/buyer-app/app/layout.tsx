import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';
import { MoboHead } from '../../../shared/layouts/MoboHead';
import { BODY_CLASSNAME, HTML_CLASSNAME } from '../../../shared/styles/moboGlobals';
import { DisableNumberScroll } from '../../../shared/components/DisableNumberScroll';
import { PwaRuntime } from './PwaRuntime';
import { plusJakartaSans, jetbrainsMono } from '../../../shared/fonts';
import { BetaBanner } from '../../../shared/components/BetaBanner';

export const metadata: Metadata = {
  title: 'BUZZMA Buyer',
  description: 'Buyer portal for exploring products, placing orders, and tracking status.',
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
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#A3E635" />
        <meta name="application-name" content="BUZZMA Buyer" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="BUZZMA Buyer" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="mask-icon" href="/icons/safari-pinned-tab.svg" color="#A3E635" />
      </head>
      <body className={BODY_CLASSNAME} suppressHydrationWarning>
        <BetaBanner />
        <DisableNumberScroll />
        <PwaRuntime app="buyer" />
        {children}
      </body>
    </html>
  );
}
