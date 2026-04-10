import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { Product } from '../types';

interface CartItem extends Product {
  quantity: number;
}

interface CartContextType {
  items: CartItem[];
  addToCart: (product: Product) => void;
  removeFromCart: (productId: string) => void;
  decreaseQuantity: (productId: string) => void;
  clearCart: () => void;
  total: number;
  itemCount: number;
}

const CART_STORAGE_PREFIX = 'mobo_cart_v2';
const MAX_ITEM_QUANTITY = 10;

const CartContext = createContext<CartContextType | undefined>(undefined);

/** Build a user-scoped storage key so carts don't leak between users on shared devices. */
function getCartStorageKey(): string {
  if (typeof window === 'undefined') return CART_STORAGE_PREFIX;
  try {
    const raw = window.localStorage.getItem('mobo_tokens_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      // Use a hash of the token to scope without storing sensitive data
      if (parsed?.accessToken) {
        // Extract the sub (user id) from the JWT payload if possible
        const parts = String(parsed.accessToken).split('.');
        if (parts.length === 3) {
          try {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(b64));
            if (payload?.sub) return `${CART_STORAGE_PREFIX}_${payload.sub}`;
          } catch { /* fall through */ }
        }
      }
    }
  } catch { /* fall through */ }
  // No valid user session — use anonymous-scoped key to prevent cross-user leakage
  return `${CART_STORAGE_PREFIX}_anon`;
}

/** Validate that a parsed item looks like a valid CartItem to guard against corrupted localStorage. */
function isValidCartItem(item: unknown): item is CartItem {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === 'string' && obj.id.length > 0 &&
    typeof obj.quantity === 'number' && Number.isFinite(obj.quantity) && obj.quantity >= 1 &&
    typeof obj.price === 'number' && Number.isFinite(obj.price) && obj.price >= 0 &&
    typeof obj.title === 'string'
  );
}

const loadPersistedCart = (): CartItem[] => {
  if (typeof window === 'undefined') return [];
  try {
    const key = getCartStorageKey();
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    // Validate each item to guard against corrupted data
    return parsed.filter(isValidCartItem).map((item) => ({
      ...item,
      quantity: Math.min(Math.max(1, Math.round(item.quantity)), MAX_ITEM_QUANTITY),
    }));
  } catch {
    return [];
  }
};

const persistCart = (items: CartItem[]) => {
  if (typeof window === 'undefined') return;
  try {
    const key = getCartStorageKey();
    localStorage.setItem(key, JSON.stringify(items));
  } catch { /* storage full or restricted */ }
};

export const CartProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<CartItem[]>(() => loadPersistedCart());

  useEffect(() => {
    persistCart(items);
  }, [items]);

  // Re-load cart when auth changes (user login/logout) to scope per-user
  useEffect(() => {
    const handleAuthChange = () => {
      setItems(loadPersistedCart());
    };
    window.addEventListener('mobo-auth-changed', handleAuthChange);
    return () => window.removeEventListener('mobo-auth-changed', handleAuthChange);
  }, []);

  const addToCart = useCallback((product: Product) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.id === product.id);
      if (existing) {
        if (existing.quantity >= MAX_ITEM_QUANTITY) return prev;
        return prev.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== productId));
  }, []);

  const decreaseQuantity = useCallback((productId: string) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.id === productId);
      if (!existing) return prev;
      if (existing.quantity <= 1) return prev.filter((item) => item.id !== productId);
      return prev.map((item) =>
        item.id === productId ? { ...item, quantity: item.quantity - 1 } : item
      );
    });
  }, []);

  const clearCart = useCallback(() => setItems([]), []);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.price * item.quantity, 0), [items]);
  const itemCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const value = useMemo(
    () => ({ items, addToCart, removeFromCart, decreaseQuantity, clearCart, total, itemCount }),
    [items, addToCart, removeFromCart, decreaseQuantity, clearCart, total, itemCount],
  );

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};
