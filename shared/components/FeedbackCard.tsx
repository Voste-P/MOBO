import React, { useState } from 'react';
import { MessageCircle, Star, CheckCircle, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';

interface FeedbackCardProps {
  role: 'user' | 'mediator' | 'agency' | 'brand';
}

export const FeedbackCard: React.FC<FeedbackCardProps> = ({ role }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  if (!user) return null;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await api.tickets.create({
        userId: user.id,
        userName: user.name,
        role,
        issueType: 'Feedback',
        description: `Rating: ${rating}/5\n${text.trim()}`,
      });
      setSent(true);
      toast.success('Feedback submitted — thank you!');
    } catch (err: unknown) {
      toast.error(formatErrorMessage(err, 'Failed to send feedback'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-[2rem] border border-zinc-100 shadow-sm mt-6">
      <div className="flex items-center gap-2 mb-5">
        <MessageCircle size={20} className="text-zinc-300" />
        <h3 className="font-bold text-zinc-900">Feedback</h3>
      </div>

      {sent ? (
        <div className="text-center py-6">
          <CheckCircle size={36} className="text-green-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-zinc-700">Thank you for your feedback!</p>
          <p className="text-xs text-zinc-400 mt-1">Your input helps us improve.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-2 block">
              Rate your experience
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRating(s)}
                  aria-label={`Rate ${s} of 5 stars`}
                  className="transition-transform hover:scale-110 active:scale-95"
                >
                  <Star
                    size={24}
                    fill={s <= rating ? '#facc15' : 'none'}
                    className={s <= rating ? 'text-yellow-400' : 'text-zinc-200'}
                  />
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1 mb-2 block">
              Tell us more
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              className="w-full p-3 bg-zinc-50 rounded-xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 h-20 resize-none"
              placeholder="What do you like? What can be better?"
            />
            {text.length > 0 && (
              <p className="text-[10px] text-zinc-300 font-bold text-right mt-1">{text.length}/2000</p>
            )}
          </div>

          <button
            type="button"
            disabled={submitting || rating === 0}
            onClick={handleSubmit}
            className="w-full py-3 bg-zinc-900 text-white font-bold rounded-xl text-sm hover:bg-lime-400 hover:text-black transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95"
          >
            {submitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                <MessageCircle size={14} /> Submit Feedback
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
