import { EventEmitter } from 'node:events';
import type { Role } from '../middleware/auth.js';

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
  };
};

type Listener = (evt: RealtimeEvent) => void;

const emitter = new EventEmitter();
// Allow many SSE clients but cap to prevent resource exhaustion.
emitter.setMaxListeners(500);

/** Track active listener count for monitoring. */
let _activeListeners = 0;

export function getActiveListenerCount(): number {
  return _activeListeners;
}

export function publishRealtime(evt: RealtimeEvent) {
  try {
    emitter.emit('event', evt);
  } catch (err) {
    // Prevent a listener error from crashing the whole process
    console.error('[RealtimeHub] emit error:', err);
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
