import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from 'react';
import { ChatMessage } from '../types';

const MAX_PERSISTED_MESSAGES = 200;
const STORAGE_KEY_PREFIX = 'mobo_v7_chat_messages';

interface ChatContextType {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  clearChat: () => void;
  /** Bind to a specific user so messages are isolated per account. */
  setUserId: (userId: string | null) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

function getStorageKey(userId: string | null): string {
  return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : `${STORAGE_KEY_PREFIX}:anon`;
}

function loadMessages(userId: string | null): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(getStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each message has required fields to prevent corrupt data from crashing rendering
    const valid = parsed.filter(
      (m: any) => m && typeof m.id === 'string' && typeof m.role === 'string' && typeof m.text === 'string'
    ) as ChatMessage[];
    return valid.slice(-MAX_PERSISTED_MESSAGES);
  } catch {
    return [];
  }
}

function persistMessages(userId: string | null, messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES);
    sessionStorage.setItem(getStorageKey(userId), JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

export const ChatProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [userId, setUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const initialized = useRef(false);
  const currentUserId = useRef<string | null>(null);

  // Load persisted messages when userId changes
  useEffect(() => {
    // Prevent persisting stale messages to the new user's key during the switch
    initialized.current = false;
    currentUserId.current = userId;
    const loaded = loadMessages(userId);
    setMessages(loaded);
    // Use a microtask to ensure setMessages has flushed before enabling persistence
    Promise.resolve().then(() => {
      // Only re-enable if userId hasn't changed again during this tick
      if (currentUserId.current === userId) {
        initialized.current = true;
      }
    });
  }, [userId]);

  // Persist messages whenever they change (debounced to avoid blocking UI on rapid messages)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!initialized.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistMessages(currentUserId.current, messages);
    }, 1_000);
    return () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current); };
  }, [messages]);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, message];
      // Cap in-memory messages to prevent memory pressure
      return next.length > MAX_PERSISTED_MESSAGES ? next.slice(-MAX_PERSISTED_MESSAGES) : next;
    });
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem(getStorageKey(userId));
      } catch {
        // ignore
      }
    }
  }, [userId]);

  return (
    <ChatContext.Provider value={{ messages, addMessage, setMessages, clearChat, setUserId }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
