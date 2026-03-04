import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  X,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Bell,
  AlertTriangle,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { useNotification } from '../context/NotificationContext';
import { api } from '../services/api';
import { Ticket, Order, Product, AiNavigateTo } from '../types';
import { ProductCard } from './ProductCard';
import { ProxiedImage } from './ProxiedImage';

interface ChatbotProps {
  isVisible?: boolean;
  onNavigate?: (tab: 'home' | 'explore' | 'orders' | 'profile' | 'tickets') => void;
}

const MoboAvatar: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'md' }) => {
  const isSmall = size === 'sm';
  const sizeClasses = isSmall ? 'w-8 h-8' : 'w-11 h-11';
  const ringSize = isSmall ? 'w-10 h-10' : 'w-14 h-14';

  return (
    <div className={`relative ${sizeClasses} flex items-center justify-center`}>
      <div
        className={`absolute ${ringSize} rounded-full bg-lime-200/40 blur-md ${
          !isSmall ? 'animate-[mobo-pulse_3s_ease-in-out_infinite]' : ''
        } motion-reduce:animate-none`}
      ></div>
      <div
        className={`${sizeClasses} rounded-full bg-gradient-to-br from-lime-300 via-emerald-300 to-cyan-300 shadow-[0_8px_20px_rgba(34,197,94,0.35)] relative overflow-hidden ${
          !isSmall ? 'animate-[mobo-float_4s_ease-in-out_infinite]' : ''
        } motion-reduce:animate-none`}
      >
        <div className="absolute -top-2 -left-2 h-6 w-6 rounded-full bg-white/50 blur-sm"></div>
        <div className="absolute bottom-2 right-2 h-2 w-2 rounded-full bg-white/70"></div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-3.5 w-3.5 rounded-full bg-white/80" />
        </div>
      </div>
    </div>
  );
};

const FormattedText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={`bold-${i}`} className="font-extrabold text-slate-900">
            {part}
          </strong>
        ) : (
          part
        )
      )}
    </span>
  );
};

export const Chatbot: React.FC<ChatbotProps> = ({ isVisible = true, onNavigate }) => {
  const { messages, addMessage, setUserId, clearChat } = useChat();
  const { notifications, removeNotification, unreadCount, markAllRead } = useNotification();
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const placeholders = useMemo(() => [
    'Find me deals...',
    'Check my latest order',
    'Where is my cashback?',
    'Navigate to my profile',
  ], []);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  const { user } = useAuth();

  // Sync chat session with logged-in user for per-user message scoping
  useEffect(() => {
    setUserId(user?.id ?? null);
  }, [user?.id, setUserId]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cache for context API calls to avoid fetching on every single message
  const contextCacheRef = useRef<{
    products: Product[];
    orders: Order[];
    tickets: Ticket[];
    fetchedAt: number;
  } | null>(null);
  const CONTEXT_CACHE_TTL = 60_000; // 1 minute

  // Track navigation timer for cleanup on unmount
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AbortController for in-flight AI requests (allows cancellation on new message / unmount)
  const abortRef = useRef<AbortController | null>(null);

  // Store the text of the last failed message so we can offer a retry button
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);

  // Clean up navigation timer and abort in-flight request on unmount
  useEffect(() => {
    return () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const makeMessageId = () => {
    try {
      if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
        return (crypto as any).randomUUID() as string;
      }
    } catch {
      // ignore
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    // Keep placeholder suggestions helpful, but avoid distraction while typing/focused.
    if (isInputFocused || inputText.trim().length > 0) return;
    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [isInputFocused, inputText, placeholders.length]);

  useEffect(() => {
    if (!isVisible) return;
    // Preserve expected chat behavior: auto-scroll only when already near the bottom.
    if (!isAtBottom) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, [messages.length, isTyping, isVisible, isAtBottom]);

  useEffect(() => {
    if (!isVisible) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [isVisible]);

  const handleSendMessage = async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    if (isTyping) return;
    const textToSend = overrideText || inputText;
    if (!textToSend.trim()) return;
    const safeText = textToSend.trim().slice(0, 400);

    addMessage({
      id: makeMessageId(),
      role: 'user',
      text: safeText,
      timestamp: Date.now(),
    });

    setInputText('');
    setIsTyping(true);
    setLastFailedText(null);

    // Cancel any in-flight AI request before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let productsForAi: Product[] = [];
    let ordersForAi: Order[] = [];
    let ticketsForAi: Ticket[] = [];

    try {
      // Use cached context if fresh enough, otherwise fetch (avoids 3 API calls per message)
      const now = Date.now();
      const cache = contextCacheRef.current;
      let allProducts: Product[];
      let userOrders: Order[];
      let allTickets: Ticket[];

      if (cache && (now - cache.fetchedAt) < CONTEXT_CACHE_TTL) {
        allProducts = cache.products;
        userOrders = cache.orders;
        allTickets = cache.tickets;
      } else {
        [allProducts, userOrders, allTickets] = await Promise.all([
          api.products.getAll(user?.mediatorCode),
          user?.id ? api.orders.getUserOrders(user.id) : Promise.resolve([]),
          api.tickets.getAll(),
        ]);
        contextCacheRef.current = {
          products: allProducts,
          orders: userOrders,
          tickets: allTickets,
          fetchedAt: now,
        };
      }
      const userTickets = user?.id
        ? allTickets.filter((t: Ticket) => t.userId === user.id)
        : [];
      productsForAi = Array.isArray(allProducts)
        ? allProducts.slice(0, 10).map((p) => ({
            ...p,
            title: String(p.title || '').slice(0, 80),
            description: String(p.description || '').slice(0, 120),
            brandName: String(p.brandName || '').slice(0, 60),
            platform: String(p.platform || '').slice(0, 30),
          }))
        : [];
      ordersForAi = Array.isArray(userOrders)
        ? userOrders.slice(0, 5).map((o) => ({
            ...o,
            items: Array.isArray(o.items)
              ? o.items.slice(0, 1).map((it: Order['items'][number]) => ({
                  ...it,
                  title: String(it.title || '').slice(0, 80),
                  brandName: it.brandName ? String(it.brandName).slice(0, 60) : it.brandName,
                }))
              : [],
            screenshots: {},
            reviewLink: undefined,
          }))
        : [];
      ticketsForAi = Array.isArray(userTickets)
        ? userTickets.slice(0, 5).map((t) => ({
            ...t,
            description: String(t.description || '').slice(0, 120),
          }))
        : [];

      // Build conversation history from recent messages for multi-turn context.
      // Filter out error messages to avoid polluting AI context with "Something went wrong" etc.
      const history = messages
        .filter((m) => (m.role === 'user' || m.role === 'model') && !m.isError)
        .slice(-6)
        .map((m) => ({
          role: m.role === 'model' ? ('assistant' as const) : ('user' as const),
          content: String(m.text || '').slice(0, 300),
        }));

      const response = await api.chat.sendMessage(
        safeText,
        user?.id || 'guest',
        user?.name || 'Guest',
        productsForAi,
        ordersForAi,
        ticketsForAi,
        undefined,
        history,
        controller.signal,
      );

      // Recommendation 1: Dynamic Navigation Handling with validation
      const VALID_NAV_TARGETS: AiNavigateTo[] = ['home', 'explore', 'orders', 'profile', 'tickets'];
      if (
        response.navigateTo &&
        response.intent === 'navigation' &&
        VALID_NAV_TARGETS.includes(response.navigateTo as AiNavigateTo)
      ) {
        // Use ref-tracked timeout so it's cancelled if component unmounts
        const navTimer = setTimeout(() => {
          onNavigate?.(response.navigateTo as AiNavigateTo);
        }, 1500);
        // Store for cleanup (will be cleared if component unmounts via effect)
        navTimerRef.current = navTimer;
      }

      addMessage({
        id: makeMessageId(),
        role: 'model',
        text: response.text,
        timestamp: Date.now(),
        relatedProducts: response.uiType === 'product_card' ? response.data : undefined,
        relatedOrders: response.uiType === 'order_card' ? response.data : undefined,
        extractedValues: response.extractedValues,
      });
    } catch (err: any) {
      // If the request was aborted (user sent a new message), silently bail
      if (err?.name === 'AbortError') return;

      const code = String(err?.code || '').toUpperCase();
      const isRate = code === 'RATE_LIMITED' || code === 'DAILY_LIMIT_REACHED' || code === 'TOO_FREQUENT';
      const lowerText = safeText.toLowerCase();
      if (lowerText.includes('deals')) {
        addMessage({
          id: makeMessageId(),
          role: 'model',
          text: productsForAi.length
            ? 'Here are some **Deals** you might like.'
            : 'Opening **Deals** for you.',
          timestamp: Date.now(),
          relatedProducts: productsForAi.length ? productsForAi.slice(0, 5) : undefined,
        });
        return;
      }
      if (lowerText.includes('latest order')) {
        onNavigate?.('orders');
        addMessage({
          id: makeMessageId(),
          role: 'model',
          text: 'Taking you to your **Orders**.',
          timestamp: Date.now(),
        });
        return;
      }
      if (lowerText.includes('support') || lowerText.includes('tickets')) {
        onNavigate?.('tickets');
        addMessage({
          id: makeMessageId(),
          role: 'model',
          text: 'Opening **Tickets** for you. You can view your support tickets or raise a new one.',
          timestamp: Date.now(),
        });
        return;
      }
      addMessage({
        id: makeMessageId(),
        role: 'model',
        text: isRate
          ? 'Please wait a few seconds before trying again.'
          : 'Something went wrong. Please try again.',
        isError: true,
        timestamp: Date.now(),
      });
      // Store the failed text so the retry button can re-send
      setLastFailedText(safeText);
    } finally {
      setIsTyping(false);
    }
  };

  const quickActions = [
    { emoji: '\u{1F525}', text: 'Deals', command: 'Show me the top 5 deals' },
    { emoji: '\u{1F4E6}', text: 'Latest Order', command: 'Where is my latest order?' },
    { emoji: '\u{1F39F}\u{FE0F}', text: 'Tickets', command: 'Check status of my support tickets' },
  ];

  const handleRetry = useCallback(() => {
    if (lastFailedText) {
      handleSendMessage(undefined, lastFailedText);
    }
  }, [lastFailedText]);

  const handleClearChat = useCallback(() => {
    abortRef.current?.abort();
    setIsTyping(false);
    setLastFailedText(null);
    clearChat();
    contextCacheRef.current = null;
  }, [clearChat]);

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[#F4F4F5] relative">
      {/* Header */}
      <div className="shrink-0 w-full bg-white border-b border-gray-100 shadow-sm px-5 py-4 safe-top flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="relative">
            <MoboAvatar size="md" />
            <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 border-[3px] border-white rounded-full z-20"></div>
          </div>
          <h1 className="font-extrabold text-lg text-slate-900 leading-none tracking-tight">
            BUZZMA
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={handleClearChat}
              aria-label="Clear chat"
              className="w-10 h-10 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-600 hover:bg-red-50 hover:text-red-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <Trash2 size={18} />
            </button>
          )}
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            aria-label={showNotifications ? 'Hide notifications' : 'Show notifications'}
            className="w-10 h-10 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-100 relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-red-500 rounded-full border border-white animate-pulse motion-reduce:animate-none"></span>
            )}
          </button>
        </div>
      </div>

      {showNotifications && (
        <div className="absolute inset-x-0 top-[72px] bottom-0 z-30 bg-black/20 backdrop-blur-[2px]" onClick={() => setShowNotifications(false)}>
          <div className="flex justify-end px-5 pt-2" onClick={(e) => e.stopPropagation()}>
            <div className="w-[78vw] max-w-[340px] bg-white rounded-[2rem] shadow-2xl border border-gray-100 p-2 animate-enter">
              <div className="px-4 py-3 flex justify-between items-center border-b border-gray-50 mb-1">
                <h3 className="font-extrabold text-sm text-slate-900">Notifications</h3>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-1 rounded-full">
                  {unreadCount > 0 ? `${unreadCount} new` : `${notifications.length}`}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 pb-2">
                <button
                  onClick={() => markAllRead()}
                  className="text-[10px] font-bold text-slate-500 hover:text-slate-900"
                >
                  Mark all read
                </button>
                <button
                  onClick={() => setShowNotifications(false)}
                  className="text-[10px] font-bold text-slate-500 hover:text-slate-900"
                >
                  Close
                </button>
              </div>
              <div className="max-h-[360px] overflow-y-auto scrollbar-hide space-y-2 p-1">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Bell size={20} className="text-slate-300 mb-2" />
                    <p className="text-xs font-bold text-slate-400">All caught up!</p>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      className="bg-slate-50 p-3 rounded-[1.2rem] relative group border border-slate-100"
                    >
                      <div className="flex gap-3">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm ${
                            n.type === 'alert'
                              ? 'bg-red-100 text-red-600'
                              : n.type === 'success'
                                ? 'bg-green-100 text-green-600'
                                : 'bg-blue-100 text-blue-600'
                          }`}
                        >
                          {n.type === 'alert' ? (
                            <AlertTriangle size={18} />
                          ) : n.type === 'success' ? (
                            <CheckCircle2 size={18} />
                          ) : (
                            <Bell size={18} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <p className="text-xs font-bold text-slate-900 mb-0.5 leading-tight">
                            {n.title}
                          </p>
                          <div className="text-[10px] font-medium text-slate-500 leading-snug">
                            {n.message}
                          </div>
                          {n.createdAt && (
                            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mt-1">
                              {new Date(n.createdAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </div>
                      {n.action && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            n.action?.onClick();
                            removeNotification(n.id);
                            setShowNotifications(false);
                          }}
                          className="mt-3 w-full py-2 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700"
                        >
                          {n.action.label}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNotification(n.id);
                        }}
                        className="absolute -top-1 -right-1 bg-white border border-gray-100 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={() => {
          const el = scrollContainerRef.current;
          if (!el) return;
          const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          setIsAtBottom(distanceFromBottom < 80);
        }}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-6 scrollbar-styled"
      >
        <div className="flex flex-col gap-6">
          {messages.length === 0 && (
            <div className="mx-auto max-w-[520px] w-full">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0">
                  <MoboAvatar size="md" />
                </div>
                <div className="bg-white border border-slate-100 rounded-[1.5rem] rounded-tl-sm px-5 py-4 shadow-sm">
                  <div className="text-sm font-semibold text-slate-900 leading-relaxed">
                    Ask me about **deals**, **orders**, or **tickets**.
                  </div>
                  <div className="mt-1 text-xs text-slate-500 leading-relaxed">
                    Use the quick actions below to get started.
                  </div>
                </div>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-enter`}
            >
              <div
                className={`flex max-w-[90%] md:max-w-[75%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} gap-3 items-end`}
              >
              {msg.role === 'model' && (
                <div className="flex-shrink-0 mb-1">
                  <MoboAvatar size="sm" />
                </div>
              )}
                <div
                  className={`flex flex-col gap-2 min-w-0 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                {msg.image && (
                  <div className="rounded-2xl overflow-hidden border-4 border-white shadow-md max-w-[200px]">
                    <ProxiedImage src={msg.image} className="w-full h-auto bg-gray-100" alt="Attachment" />
                  </div>
                )}
                {msg.text && (
                  <div
                    className={`px-5 py-3 text-[15px] leading-relaxed shadow-sm relative break-words whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-black text-white rounded-[1.5rem] rounded-tr-sm'
                        : 'bg-white text-slate-800 rounded-[1.5rem] rounded-tl-sm border border-slate-100 font-medium'
                    } ${msg.isError ? 'bg-red-50 border-red-100 text-red-600' : ''}`}
                  >
                    <FormattedText text={msg.text} />
                    {msg.isError && lastFailedText && !isTyping && (
                      <button
                        onClick={handleRetry}
                        className="mt-2 flex items-center gap-1 text-xs font-bold text-red-500 hover:text-red-700 transition-colors"
                      >
                        <RotateCcw size={12} /> Retry
                      </button>
                    )}
                  </div>
                )}
                </div>
              </div>
            {msg.relatedProducts && msg.relatedProducts.length > 0 && (
              <div className="w-screen relative left-1/2 -translate-x-1/2 mt-4 pl-4 overflow-x-auto scrollbar-hide snap-x">
                <div className="flex gap-4 w-max pr-8 pl-4 pb-4">
                  {msg.relatedProducts.map((product) => (
                    <ProductCard key={product.id} product={product} />
                  ))}
                </div>
              </div>
            )}
            {msg.extractedValues && Object.keys(msg.extractedValues).length > 0 && (
              <div className="ml-11 mt-3 w-full max-w-[320px]">
                <div className="bg-gradient-to-br from-emerald-50 to-cyan-50 rounded-2xl p-4 shadow-sm border border-emerald-100">
                  <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <CheckCircle2 size={12} /> Extracted Details
                  </p>
                  <div className="space-y-2">
                    {msg.extractedValues.orderId && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Order ID</span>
                        <span className="text-[11px] font-bold text-slate-800 font-mono">{msg.extractedValues.orderId}</span>
                      </div>
                    )}
                    {msg.extractedValues.amount && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Amount</span>
                        <span className="text-[11px] font-bold text-emerald-700">{msg.extractedValues.amount}</span>
                      </div>
                    )}
                    {msg.extractedValues.productName && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Product</span>
                        <span className="text-[11px] font-semibold text-slate-700 truncate max-w-[180px]">{msg.extractedValues.productName}</span>
                      </div>
                    )}
                    {msg.extractedValues.platform && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Platform</span>
                        <span className="text-[11px] font-semibold text-slate-700">{msg.extractedValues.platform}</span>
                      </div>
                    )}
                    {msg.extractedValues.seller && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Seller</span>
                        <span className="text-[11px] font-semibold text-slate-700 truncate max-w-[180px]">{msg.extractedValues.seller}</span>
                      </div>
                    )}
                    {msg.extractedValues.orderDate && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Date</span>
                        <span className="text-[11px] font-semibold text-slate-700">{msg.extractedValues.orderDate}</span>
                      </div>
                    )}
                    {msg.extractedValues.paymentMethod && (
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-slate-500">Payment</span>
                        <span className="text-[11px] font-semibold text-slate-700">{msg.extractedValues.paymentMethod}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {msg.relatedOrders && msg.relatedOrders.length > 0 && (
              <div className="ml-11 mt-3 space-y-3 w-full max-w-[320px]">
                {msg.relatedOrders.map((order) => {
                  const isPaid = order.paymentStatus === 'Paid';
                  const isVerified = order.affiliateStatus === 'Pending_Cooling';
                  return (
                    <div
                      key={order.id}
                      className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 relative overflow-hidden active:scale-95 transition-transform"
                    >
                      <div
                        className={`absolute left-0 top-0 bottom-0 w-1.5 ${isPaid ? 'bg-green-500' : isVerified ? 'bg-blue-500' : 'bg-orange-500'}`}
                      ></div>
                      <div className="flex gap-4">
                        <div className="w-14 h-14 bg-slate-50 rounded-xl p-1.5 border border-slate-100 flex-shrink-0">
                          <ProxiedImage loading="lazy"
                            src={order.items?.[0]?.image || ''}
                            className="w-full h-full object-contain mix-blend-multiply"
                            alt=""
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-slate-900 truncate mb-1">
                            {order.items?.[0]?.title || 'Order'}
                          </p>
                          <div className="flex justify-between items-end">
                            <div className="flex flex-col">
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded w-fit uppercase ${isPaid ? 'bg-green-100 text-green-700' : isVerified ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}
                              >
                                {isPaid ? 'Settled' : isVerified ? 'Verified' : order.status}
                              </span>
                              {order.expectedSettlementDate && !isPaid && (
                                <span className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                                  <CalendarClock size={10} />{' '}
                                  {new Date(order.expectedSettlementDate).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                            <span className="text-sm font-mono font-bold text-slate-900">
                              {order.total}
                            </span>
                          </div>
                        </div>
                      </div>
                      {isPaid && (
                        <div className="absolute top-2 right-2 text-green-500">
                          <CheckCircle2 size={16} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          ))}
          {isTyping && (
            <div
              role="status"
              aria-live="polite"
              aria-label="BUZZMA is typing"
              className="ml-11 flex gap-1.5 p-3 items-center bg-white w-fit rounded-2xl rounded-tl-sm border border-slate-100 shadow-sm"
            >
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce motion-reduce:animate-none"></span>
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.1s] motion-reduce:animate-none"></span>
              <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0.2s] motion-reduce:animate-none"></span>
            </div>
          )}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      </div>

      <div className="shrink-0 w-full px-4 pb-20 safe-bottom">
        <div className="flex flex-nowrap gap-2 justify-center pb-3 overflow-x-auto scrollbar-hide">
          {quickActions.map((action) => (
            <button
              key={action.command}
              onClick={() => handleSendMessage(undefined, action.command)}
              disabled={isTyping}
              className={`px-3.5 py-2 bg-white shadow-sm border border-slate-100 rounded-2xl text-[11px] font-bold text-slate-600 active:scale-95 flex items-center gap-2 hover:bg-slate-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#F4F4F5] whitespace-nowrap ${isTyping ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span className="text-base">{action.emoji}</span> {action.text}
            </button>
          ))}
        </div>

        <div className="bg-white p-2 pl-4 rounded-[2rem] shadow-xl border border-slate-100 flex items-center gap-2 relative">
          <form onSubmit={(e) => handleSendMessage(e)} className="flex-1 min-w-0">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              placeholder={placeholders[placeholderIndex]}
              className="w-full bg-transparent border-none outline-none text-sm font-semibold text-slate-900 h-11 placeholder:text-slate-400"
            />
          </form>
          <button
            onClick={(e) => handleSendMessage(e)}
            disabled={!inputText.trim()}
            aria-label="Send message"
            className={`w-11 h-11 rounded-full flex items-center justify-center shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${!inputText.trim() ? 'bg-slate-100 text-slate-300 shadow-none cursor-not-allowed' : 'bg-black text-white hover:bg-lime-300 hover:text-black'}`}
          >
            <ArrowRight size={20} strokeWidth={3} />
          </button>
        </div>
      </div>
    </div>
  );
};
