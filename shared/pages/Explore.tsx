import React, { useMemo, useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useToast } from '../context/ToastContext';
import { Product } from '../types';
import { ProductCard } from '../components/ProductCard';
import { RaiseTicketModal } from '../components/RaiseTicketModal';
import { Search, Filter, AlertTriangle, ShoppingBag } from 'lucide-react';
import { EmptyState, Input } from '../components/ui';

export const Explore: React.FC = () => {
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedDealType, setSelectedDealType] = useState('All');
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const silentSyncRef = useRef(false);
  const [ticketOpen, setTicketOpen] = useState(false);

  const dealTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const p of products) {
      const dt = (p.dealType || '').trim();
      if (dt) seen.add(dt);
    }
    return ['All', ...Array.from(seen).sort()];
  }, [products]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const p of products) {
      const cat = (p.category || '').trim();
      if (cat) seen.add(cat);
    }
    return ['All', ...Array.from(seen).sort()];
  }, [products]);

  const fetchDeals = async (silent = false) => {
    if (silent) {
      if (silentSyncRef.current) return;
      silentSyncRef.current = true;
    } else {
      setLoading(true);
      setFetchError(false);
    }
    try {
      const data = await api.products.getAll();
      setProducts(Array.isArray(data) ? data : []);
      setFetchError(false);
    } catch (err) {
      console.error(err);
      if (!silent) {
        toast.error('Failed to load deals. Please try again.');
        setFetchError(true);
      }
    } finally {
      setLoading(false);
      silentSyncRef.current = false;
    }
  };

  useEffect(() => {
    fetchDeals();

    let timer: any = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fetchDeals(true);
      }, 400);
    };

    // Realtime inventory updates (SSE)
    const unsub = subscribeRealtime((msg) => {
      if (msg.type === 'deals.changed') schedule();
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Derived filtered list — no extra state or effect needed
  const filtered = useMemo(() => {
    let result = products;

    // Filter by deal type
    if (selectedDealType !== 'All') {
      const dtLower = selectedDealType.toLowerCase();
      result = result.filter((p) => String(p.dealType || '').toLowerCase() === dtLower);
    }

    if (selectedCategory !== 'All') {
      const selectedLower = selectedCategory.toLowerCase();
      result = result.filter((p) => {
        const category = String(p.category || '').toLowerCase();
        const dealType = String(p.dealType || '').toLowerCase();
        const platform = String(p.platform || '').toLowerCase();
        const title = String(p.title || '').toLowerCase();

        return (
          category === selectedLower ||
          dealType === selectedLower ||
          platform === selectedLower ||
          title.includes(selectedLower)
        );
      });
    }

    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(lower) ||
          p.description.toLowerCase().includes(lower) ||
          p.platform.toLowerCase().includes(lower) ||
          p.brandName.toLowerCase().includes(lower)
      );
    }

    return result;
  }, [searchTerm, selectedCategory, selectedDealType, products]);

  useEffect(() => {
    if (selectedCategory === 'All') return;
    if (categories.includes(selectedCategory)) return;
    setSelectedCategory('All');
  }, [categories, selectedCategory]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#F4F4F5]">
      {/* Header — compact for maximum content visibility */}
      <div className="px-4 pt-10 pb-2 bg-white/95 backdrop-blur-md shadow-sm z-10 border-b border-gray-100 sticky top-0">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-black tracking-widest text-lime-600 bg-lime-50 px-1.5 py-0.5 rounded border border-lime-200">BUZZMA</span>
            <h1 className="text-lg font-extrabold text-slate-900">Explore Deals</h1>
          </div>
          <button
            onClick={() => setTicketOpen(true)}
            className="w-8 h-8 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-500 hover:bg-red-100 transition-all active:scale-95"
            aria-label="Raise a ticket"
          >
            <AlertTriangle size={14} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="mb-2">
          <Input
            placeholder="Search deals, brands, platforms..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            leftIcon={<Search size={16} />}
            aria-label="Search deals"
          />
        </div>

        {/* Deal Type Filter */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1 mb-1.5">
          {dealTypes.map((dt) => {
            const label = dt === 'Discount' ? 'Order Deal' : dt === 'All' ? 'All Types' : `${dt} Deal`;
            return (
              <button
                key={dt}
                type="button"
                onClick={() => setSelectedDealType(dt)}
                aria-pressed={selectedDealType === dt}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all border whitespace-nowrap ${
                  selectedDealType === dt
                    ? 'bg-lime-500 text-white border-lime-500 shadow'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-lime-300'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Categories */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              aria-pressed={selectedCategory === cat}
              className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all border whitespace-nowrap ${
                selectedCategory === cat
                  ? 'bg-black text-white border-black shadow'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 pb-32 scrollbar-styled overscroll-none">
        {loading ? (
          <div className="flex flex-col items-center gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-[300px] bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 space-y-3 animate-pulse" style={{ animationDelay: `${i * 150}ms` }}>
                <div className="flex gap-4">
                  <div className="w-24 h-24 rounded-2xl bg-gray-200 flex-shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-4 w-3/4 rounded-lg bg-gray-200" />
                    <div className="h-3 w-1/2 rounded-lg bg-gray-200" />
                    <div className="h-6 w-20 rounded-lg bg-gray-200 mt-2" />
                  </div>
                </div>
                <div className="h-16 rounded-xl bg-gray-200" />
                <div className="h-12 rounded-xl bg-gray-200" />
              </div>
            ))}
          </div>
        ) : fetchError && filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Filter size={40} className="text-zinc-300" />
            <p className="text-sm font-bold text-zinc-500">Failed to load deals</p>
            <button
              type="button"
              onClick={() => fetchDeals()}
              className="px-6 py-2.5 bg-black text-white rounded-full text-xs font-bold hover:bg-zinc-800 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No deals available"
            description={searchTerm || selectedCategory !== 'All' ? 'Try a different search term or category.' : 'New deals will appear here — check back soon!'}
            icon={searchTerm ? <Search size={40} className="text-zinc-300" /> : <ShoppingBag size={40} className="text-zinc-300" />}
          />
        ) : (
          <div className="flex flex-col items-center gap-6">
            {filtered.map((p, i) => (
              <div key={p.id} className="animate-enter w-full flex justify-center" style={{ animationDelay: `${Math.min(i, 8) * 60}ms`, animationFillMode: 'both' }}>
                <ProductCard product={p} inlineOrder />
              </div>
            ))}
          </div>
        )}
      </div>
      <RaiseTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
    </div>
  );
};
