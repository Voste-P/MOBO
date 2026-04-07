import { EventEmitter } from 'node:events';
import type { Role } from '../middleware/auth.js';
import { logErrorEvent } from '../config/appLogs.js';

export type RealtimeEvent = {
  type: string;
  ts: string;
  payload?: any;
  audience: {
    broadcast?: boolean;
    userIds?: string[];
    roles?: Role[];
    // Deliver to a specific agency account by its agency code (stored on User.mediatorCode for role=agency).
    agencyCodes?: string[];
    // Deliver to a specific mediator account by its mediator code (stored on User.mediatorCode for role=mediator).
    mediatorCodes?: string[];
    // Deliver to a specific brand account by its brand code (stored on User.brandCode for role=brand).
    brandCodes?: string[];
    // Deliver to users that have this parentCode (e.g., shoppers with parentCode=mediatorCode).
    parentCodes?: string[];
    // Pre-normalised Sets for O(1) delivery checks (populated at publish time)
    _agencySet?: Set<string>;
    _mediatorSet?: Set<string>;
    _brandSet?: Set<string>;
    _parentSet?: Set<string>;
  };
};

type Listener = (evt: RealtimeEvent) => void;

const emitter = new EventEmitter();
// Allow many SSE clients but cap to prevent resource exhaustion.
const MAX_GLOBAL_LISTENERS = 500;
emitter.setMaxListeners(MAX_GLOBAL_LISTENERS);

/** Track active listener count for monitoring. */
let _activeListeners = 0;

export function getActiveListenerCount(): number {
  return _activeListeners;
}

export function isAtCapacity(): boolean {
  return _activeListeners >= MAX_GLOBAL_LISTENERS;
}

function normalizeCodeSet(codes?: string[]): Set<string> | undefined {
  if (!Array.isArray(codes) || codes.length === 0) return undefined;
  return new Set(codes.map(c => String(c || '').trim().toLowerCase()));
}

export function publishRealtime(evt: RealtimeEvent) {
  try {
    // Pre-normalise audience code arrays into Sets for O(1) lookups in shouldDeliver
    const aud = evt.audience;
    if (aud && !aud.broadcast) {
      aud._agencySet = normalizeCodeSet(aud.agencyCodes);
      aud._mediatorSet = normalizeCodeSet(aud.mediatorCodes);
      aud._brandSet = normalizeCodeSet(aud.brandCodes);
      aud._parentSet = normalizeCodeSet(aud.parentCodes);
    }
    emitter.emit('event', evt);
  } catch (err) {
    // Prevent a listener error from crashing the whole process
    logErrorEvent({ category: 'SYSTEM', severity: 'medium', message: '[RealtimeHub] emit error', error: err instanceof Error ? err : new Error(String(err)) });
  }
}

export function publishBroadcast(type: string, payload?: any) {
  publishRealtime({ type, ts: new Date().toISOString(), payload, audience: { broadcast: true } });
}

/**
 * Subscribe to realtime events. Returns an unsubscribe function that MUST be
 * called when the SSE client disconnects to prevent listener leaks.
 */
export function subscribeRealtime(listener: Listener) {
  _activeListeners++;
  emitter.on('event', listener);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return; // prevent double-unsubscribe
    unsubscribed = true;
    _activeListeners--;
    emitter.off('event', listener);
  };
}
