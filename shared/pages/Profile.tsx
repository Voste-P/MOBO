import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';
import { maskMobile } from '../utils/mobiles';
import { ProxiedImage } from '../components/ProxiedImage';
import { api, asArray } from '../services/api';
import { BetaLock } from '../components/BetaLock';
import { subscribeRealtime } from '../services/realtime';
import {
  Camera,
  QrCode,
  CreditCard,
  Save,
  Edit2,
  LogOut,
  TrendingUp,
  ShieldCheck,
  Plus,
  CheckCircle,
  MessageCircle,
  Star,
  Loader2,
} from 'lucide-react';
import { Order } from '../types';

export const Profile: React.FC = () => {
  const { user, updateUser, logout } = useAuth();
  const { toast } = useToast();

  // Form State
  const [name, setName] = useState(user?.name || '');
  const [mobile, setMobile] = useState(user?.mobile || '');
  const [upiId, setUpiId] = useState(user?.upiId || '');
  const [upiError, setUpiError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Images
  const [avatar, setAvatar] = useState<string | undefined>(user?.avatar);
  const [qrCode, setQrCode] = useState<string | undefined>(user?.qrCode);

  // Stats
  const [orders, setOrders] = useState<Order[]>([]);
  const [totalSpent, setTotalSpent] = useState(0);
  const [isStatsLoading, setIsStatsLoading] = useState(false);
  const statsLoadingRef = useRef(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);

  // Feedback state
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  // Re-sync form fields when the user identity changes (login/logout)
  // but not on every user object refresh from realtime, and not while editing.
  const prevUserIdRef = useRef(user?.id);
  useEffect(() => {
    if (!user || isEditing) return;
    // Only re-sync if the user identity changed (login/switch), not on every object refresh
    if (prevUserIdRef.current === user.id) return;
    prevUserIdRef.current = user.id;
    setName(user.name || '');
    setMobile(user.mobile || '');
    setUpiId(user.upiId || '');
    setAvatar(user.avatar);
    setQrCode(user.qrCode);
  }, [user?.id, isEditing]);

  /** Validate UPI ID format: handle@provider, 3-50 chars */
  function validateUpiId(value: string): string {
    if (!value) return ''; // optional field
    if (value.length > 50) return 'UPI ID is too long (max 50 characters)';
    if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/.test(value)) {
      return 'Invalid format — use handle@provider (e.g. name@upi)';
    }
    return '';
  }

  useEffect(() => {
    if (user) refreshStats();
  }, [user?.id]);

  // Refresh stats when orders change via realtime
  useEffect(() => {
    if (!user?.id) return;
    if (user.role !== 'user') return;


    let timer: any = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshStats({ silent: true });
      }, 600);
    };

    const unsub = subscribeRealtime((msg: any) => {
      if (msg.type === 'orders.changed') schedule();
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user?.id]);

  const refreshStats = async (opts?: { silent?: boolean }) => {
    if (!user) return;
    if (statsLoadingRef.current) return;
    statsLoadingRef.current = true;
    setIsStatsLoading(true);
    try {
      const userOrders = asArray<Order>(await api.orders.getUserOrders(user.id));
      setOrders(userOrders);
      const spent = userOrders
        .filter((o: Order) => o.paymentStatus === 'Paid')
        .reduce((acc: number, o: Order) => acc + o.total, 0);
      setTotalSpent(spent);
    } catch (e) {
      console.error(e);
      if (!opts?.silent) {
        toast.error(formatErrorMessage(e, 'Failed to refresh wallet stats.'));
      }
    } finally {
      statsLoadingRef.current = false;
      setIsStatsLoading(false);
    }
  };

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB max
  const VALID_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'avatar' | 'qr') => {
    const file = e.target.files?.[0];
    if (file) {
      if (!VALID_IMAGE_TYPES.has(file.type)) {
        toast.error('Please upload a JPG, PNG, or WebP image.');
        e.target.value = '';
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error('Image too large (max 5 MB). Please choose a smaller file.');
        e.target.value = '';
        return;
      }
      if (!isEditing) {
        setIsEditing(true);
        toast.info('Editing enabled — make changes, then tap Save.');
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        if (type === 'avatar') setAvatar(base64);
        else setQrCode(base64);
      };
      reader.onerror = () => {
        toast.error('Failed to read image. Please try again.');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSaving) return;

    // Validate UPI before saving
    const upiValidationError = validateUpiId(upiId);
    if (upiValidationError) {
      setUpiError(upiValidationError);
      toast.error(upiValidationError);
      return;
    }

    if (!name.trim()) {
      toast.error('Name cannot be empty');
      return;
    }

    setIsSaving(true);

    try {
      // Backend profile update does not allow changing mobile via this endpoint.
      await updateUser({ name, upiId, avatar, qrCode });
      toast.success('Profile updated');
      setIsEditing(false);
    } catch (e) {
      toast.error(formatErrorMessage(e, 'Failed to update profile'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#F4F4F5] relative overflow-y-auto scrollbar-styled overscroll-none">
      <div className="max-w-xl mx-auto w-full p-6 pb-32 space-y-6">
        {/* Identity Card */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 relative overflow-hidden animate-enter">
          <div className="flex justify-between items-center mb-8">
            <h3 className="font-extrabold text-xl text-zinc-900">Identity</h3>
            <button
              type="button"
              aria-label={isEditing ? 'Save profile' : 'Edit profile'}
              disabled={isSaving}
              onClick={() => (isEditing ? handleSave() : setIsEditing(true))}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${isEditing ? 'bg-green-100 text-green-600' : 'bg-zinc-50 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              {isEditing ? (
                isSaving ? (
                  <div className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save size={18} />
                )
              ) : (
                <Edit2 size={18} />
              )}
            </button>
          </div>

          {/* Avatar Row */}
          <div className="flex items-center gap-6 mb-8">
            <button
              type="button"
              className="relative group cursor-pointer"
              aria-label="Change avatar"
              onClick={() => avatarInputRef.current?.click()}
            >
              <div className="w-24 h-24 rounded-[1.5rem] bg-zinc-100 flex items-center justify-center text-4xl font-black text-zinc-300 shadow-inner overflow-hidden border-4 border-white">
                {avatar ? (
                  <ProxiedImage
                    src={avatar}
                    alt="Avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (name || '?').charAt(0)
                )}
              </div>
              {isEditing && (
                <div className="absolute inset-0 bg-black/20 flex items-center justify-center rounded-[1.5rem] backdrop-blur-sm">
                  <Camera className="text-white" />
                </div>
              )}
            </button>
            <input
              type="file"
              ref={avatarInputRef}
              className="hidden"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Upload avatar image"
              onChange={(e) => handleImageUpload(e, 'avatar')}
            />
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-black text-zinc-900 leading-tight truncate">{name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="px-3 py-1 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold border border-blue-100 uppercase tracking-wide">
                  {user?.role}
                </span>
                {user?.isVerifiedByMediator && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100">
                    <ShieldCheck size={12} /> Verified
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <div className="group">
              <label htmlFor="profile-name" className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-1.5 block">
                Full Name
              </label>
              <input
                id="profile-name"
                type="text"
                disabled={!isEditing}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none focus:ring-2 focus:ring-lime-400 disabled:bg-zinc-50/50 disabled:text-zinc-500 transition-all"
              />
            </div>
            <div className="group">
              <label htmlFor="profile-mobile" className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-1.5 block">
                Mobile Number
              </label>
              <input
                id="profile-mobile"
                type="tel"
                readOnly
                value={maskMobile(mobile)}
                className="w-full p-4 bg-zinc-50/50 border-none rounded-2xl font-bold text-zinc-500 outline-none transition-all font-mono cursor-not-allowed"
              />
            </div>
            <div className="group">
              <label htmlFor="profile-upi" className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-1.5 block">
                UPI Address
              </label>
              <div className="relative">
                <input
                  type="text"
                  id="profile-upi"
                  disabled={!isEditing}
                  value={upiId}
                  maxLength={50}
                  onChange={(e) => {
                    const val = e.target.value;
                    setUpiId(val);
                    setUpiError(validateUpiId(val));
                  }}
                  className={`w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none focus:ring-2 ${upiError ? 'focus:ring-red-400' : 'focus:ring-lime-400'} disabled:bg-zinc-50/50 disabled:text-zinc-500 transition-all`}
                  placeholder="user@upi"
                />
                {!isEditing && upiId && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-green-500">
                    <CheckCircle size={16} />
                  </div>
                )}
              </div>
              {upiError && isEditing && (
                <p className="text-xs text-red-500 font-medium mt-1.5 ml-1">{upiError}</p>
              )}
            </div>
          </div>
        </div>

        {/* Wallet / Treasury Card */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 flex flex-col animate-slide-up">
          <div className="flex items-center justify-between mb-8">
            <h3 className="font-extrabold text-xl text-zinc-900 flex items-center gap-2">
              <CreditCard size={24} className="text-zinc-300" /> Wallet
            </h3>
          </div>

          <div className="flex-1 flex flex-col justify-center items-center text-center mb-8">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-2">
              Total Spent
            </p>
            <h2 className="text-5xl font-black text-zinc-900 tracking-tighter">
              {isStatsLoading ? (
                <div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-600 rounded-full animate-spin motion-reduce:animate-none mx-auto" role="status" aria-label="Loading wallet stats" />
              ) : (
                `₹${totalSpent.toLocaleString('en-IN')}`
              )}
            </h2>
            <div className="flex items-center gap-2 mt-4 bg-green-50 text-green-700 px-3 py-1.5 rounded-full text-xs font-bold border border-green-100">
              <TrendingUp size={14} /> +{orders.length} lifetime orders
            </div>
          </div>

          <div className="space-y-3">
            <BetaLock>
            {qrCode ? (
              <button
                type="button"
                className="w-full flex justify-between items-center p-4 bg-zinc-50 rounded-2xl border border-zinc-100 cursor-pointer hover:bg-zinc-100 transition-colors"
                onClick={() => qrInputRef.current?.click()}
                aria-label="Change payment QR"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-zinc-400 shadow-sm">
                    <QrCode size={20} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-zinc-900">Payment QR</p>
                    <p className="text-[10px] font-mono text-zinc-400">Linked</p>
                  </div>
                </div>
                {isEditing && (
                  <span className="text-[10px] font-bold text-zinc-400 uppercase">Change</span>
                )}
              </button>
            ) : (
              <button
                type="button"
                className="w-full flex justify-between items-center p-4 bg-zinc-50 rounded-2xl cursor-pointer hover:bg-zinc-100 border border-zinc-100"
                onClick={() => qrInputRef.current?.click()}
                aria-label="Add payment QR"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-zinc-400 shadow-sm">
                    <QrCode size={20} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-zinc-900">Add QR Code</p>
                    <p className="text-[10px] text-zinc-400">For refunds</p>
                  </div>
                </div>
                <div className="w-8 h-8 rounded-full bg-white border border-zinc-200 flex items-center justify-center shadow-sm">
                  <Plus size={14} className="text-zinc-500" />
                </div>
              </button>
            )}
            <input
              type="file"
              ref={qrInputRef}
              className="hidden"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Upload payment QR code"
              onChange={(e) => handleImageUpload(e, 'qr')}
            />
            </BetaLock>

            {/* Stats Row */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="p-4 bg-zinc-50 rounded-2xl border border-zinc-100 text-center">
                <p className="text-xl font-black text-zinc-900">
                  {orders.filter((o) => o.paymentStatus === 'Paid').length}
                </p>
                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">
                  Settled
                </p>
              </div>
              <div className="p-4 bg-zinc-50 rounded-2xl border border-zinc-100 text-center">
                <p className="text-xl font-black text-zinc-900">
                  {orders.filter((o) => o.paymentStatus === 'Pending').length}
                </p>
                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">
                  Pending
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Feedback / App Experience */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 animate-slide-up">
          <div className="flex items-center gap-2 mb-6">
            <MessageCircle size={24} className="text-zinc-300" />
            <h3 className="font-extrabold text-xl text-zinc-900">Feedback</h3>
          </div>

          {feedbackSent ? (
            <div className="text-center py-6">
              <CheckCircle size={40} className="text-green-500 mx-auto mb-3" />
              <p className="text-sm font-bold text-zinc-700">Thank you for your feedback!</p>
              <p className="text-xs text-zinc-400 mt-1">Your response helps us improve the experience.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <label htmlFor="feedback-stars" className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-2 block">
                  Rate your experience
                </label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setFeedbackRating(s)}
                      aria-label={`Rate ${s} of 5 stars`}
                      className="transition-transform hover:scale-110 active:scale-95"
                    >
                      <Star
                        size={28}
                        fill={s <= feedbackRating ? '#facc15' : 'none'}
                        className={s <= feedbackRating ? 'text-yellow-400' : 'text-zinc-200'}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="feedback-text" className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-2 block">
                  Tell us more
                </label>
                <textarea
                  id="feedback-text"
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  maxLength={2000}
                  className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 h-24 resize-none"
                  placeholder="What do you like? What can be better?"
                />
              </div>

              <button
                type="button"
                disabled={feedbackSubmitting || feedbackRating === 0}
                onClick={async () => {
                  setFeedbackSubmitting(true);
                  try {
                    await api.tickets.create({
                      userId: user!.id,
                      userName: user!.name,
                      role: 'user',
                      issueType: 'Feedback',
                      description: `Rating: ${feedbackRating}/5\n${feedbackText.trim()}`,
                    });
                    setFeedbackSent(true);
                    toast.success('Feedback submitted — thank you!');
                  } catch (err: any) {
                    toast.error(formatErrorMessage(err, 'Failed to send feedback'));
                  } finally {
                    setFeedbackSubmitting(false);
                  }
                }}
                className="w-full py-4 bg-black text-white font-bold rounded-2xl text-sm hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95"
              >
                {feedbackSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>
                    <MessageCircle size={16} /> Submit Feedback
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Danger Zone */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 animate-slide-up">
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Are you sure you want to sign out?')) logout();
            }}
            className="w-full py-4 border-2 border-red-50 text-red-500 font-bold rounded-2xl text-sm hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
          >
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};
