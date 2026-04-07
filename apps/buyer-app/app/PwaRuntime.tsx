'use client';

import { useEffect } from 'react';
import { api } from '../../../shared/services/api';

const TOKEN_STORAGE_KEY = 'mobo_tokens_v1';

function hasAuthToken(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!parsed?.accessToken;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

type PushSubscriptionPayload = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

function normalizePushSubscription(subscription: PushSubscription): PushSubscriptionPayload | null {
  const json = subscription.toJSON();
  const endpoint = String(json.endpoint || '').trim();
  const keys = (json.keys || {}) as { p256dh?: string; auth?: string };
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) return null;
  return {
    endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

async function ensurePushSubscription(app: 'buyer' | 'mediator') {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!hasAuthToken()) return;

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();

  let subscription = existing;
  if (!subscription) {
    const keyRes = await api.notifications.push.publicKey();
    const publicKey = String(keyRes?.publicKey || '').trim();
    if (!publicKey) return;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const payload = normalizePushSubscription(subscription);
  if (!payload) return;

  await api.notifications.push.subscribe({
    app,
    subscription: payload,
    userAgent: navigator.userAgent,
  });
}

function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true
  );
}

export function PwaRuntime({ app }: { app: 'buyer' | 'mediator' }) {
  /* ─Back-swipe / back-button trap (prevents PWA from closing) ─*/
  useEffect(() => {
    if (!isStandalonePwa()) return;
    const GUARD = 'mobo-pwa-guard';

    // Push two guard entries so single/double back-press can't escape
    if (history.state !== GUARD) {
      history.replaceState(GUARD, '');
      history.pushState(GUARD, '');
      history.pushState(GUARD, '');
    }

    const onPopState = () => {
      // Always push a fresh guard so the user can never exhaust the stack
      history.pushState(GUARD, '');
    };

    window.addEventListener('popstate', onPopState);

    // iOS/Android: prevent overscroll-based navigation gestures
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      window.removeEventListener('popstate', onPopState);
      document.documentElement.style.overscrollBehavior = '';
      document.body.style.overscrollBehavior = '';
    };
  }, []);

  /* ─Prevent pinch-zoom and double-tap zoom on iOS/Android ─*/
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    const preventMulti = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };

    // Prevent iOS Safari gesture zoom
    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    document.addEventListener('gestureend', prevent, { passive: false });
    // Prevent multi-touch zoom
    document.addEventListener('touchmove', preventMulti, { passive: false });

    // Prevent double-tap zoom (track quick taps < 300ms apart)
    let lastTap = 0;
    const onTouchEnd = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); }
      lastTap = now;
    };
    document.addEventListener('touchend', onTouchEnd, { passive: false });

    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('gestureend', prevent);
      document.removeEventListener('touchmove', preventMulti);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  useEffect(() => {
    (globalThis as any).__MOBO_ENABLE_PWA_GUARDS__ = true;
    (globalThis as any).__MOBO_PWA_APP__ = app;

    if ('serviceWorker' in navigator) {
      // next-pwa handles registration via register:true in next.config.js.
      // We only wait for the active SW to set up sync & push.
      const setupWorker = () => {
        navigator.serviceWorker.ready
          .then((registration) => {
            (registration as any).sync
              ?.register('buzzma-background-sync')
              .catch(() => undefined);

            (registration as any).periodicSync
              ?.register('buzzma-periodic-sync', {
                minInterval: 24 * 60 * 60 * 1000,
              })
              .catch(() => undefined);

            ensurePushSubscription(app).catch(() => undefined);
          })
          .catch(() => undefined);
      };

      if (document.readyState === 'complete') {
        setupWorker();
      } else {
        window.addEventListener('load', setupWorker, { once: true });
      }
    }

    const handleAuthChange = () => {
      ensurePushSubscription(app).catch(() => undefined);
    };
    window.addEventListener('mobo-auth-changed', handleAuthChange as EventListener);

    return () => {
      window.removeEventListener('mobo-auth-changed', handleAuthChange as EventListener);
    };
  }, [app]);

  return null;
}
