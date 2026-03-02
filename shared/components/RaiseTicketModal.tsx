import React, { useState, useCallback } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';

interface RaiseTicketModalProps {
  open: boolean;
  onClose: () => void;
}

const ISSUE_TYPES = ['Cashback Delay', 'Wrong Amount', 'Account Issue', 'Other'] as const;

export const RaiseTicketModal: React.FC<RaiseTicketModalProps> = ({ open, onClose }) => {
  const { user } = useAuth();
  const { toast } = useToast();

  const [issueType, setIssueType] = useState<string>(ISSUE_TYPES[0]);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setIssueType(ISSUE_TYPES[0]);
    setDescription('');
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    reset();
    onClose();
  }, [submitting, reset, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!user || !description.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.tickets.create({
        userId: user.id,
        userName: user.name || 'User',
        role: (user as any).role || (user as any).roles?.[0] || 'user',
        issueType,
        description: description.trim(),
      });
      toast.success('Ticket raised! Support will contact you shortly.');
      reset();
      onClose();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to raise ticket.'));
    } finally {
      setSubmitting(false);
    }
  }, [user, description, submitting, issueType, toast, reset, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="bg-white w-full max-w-sm rounded-[2rem] p-6 shadow-2xl animate-slide-up relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          aria-label="Close"
          className="absolute top-4 right-4 p-2 bg-gray-100 rounded-full hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          <X size={16} />
        </button>

        <h3 className="text-xl font-extrabold text-slate-900 mb-1 flex items-center gap-2">
          <AlertTriangle className="text-red-500" size={20} /> Raise a Ticket
        </h3>
        <p className="text-xs text-slate-500 font-bold uppercase mb-6">
          Support will review your issue
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block mb-2">
              Issue Type
            </label>
            <div className="flex flex-wrap gap-2">
              {ISSUE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setIssueType(type)}
                  className={`px-3 py-2 rounded-lg text-xs font-bold border transition-all ${
                    issueType === type
                      ? 'bg-red-50 text-red-600 border-red-200'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block mb-2">
              Details
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-sm outline-none focus:ring-2 focus:ring-red-400 h-24 resize-none"
              placeholder="Describe the issue..."
            />
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !description.trim()}
            className="w-full py-4 bg-black text-white font-bold rounded-2xl flex items-center justify-center gap-2 hover:bg-red-600 transition-all disabled:opacity-50 active:scale-95"
          >
            {submitting ? (
              <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
            ) : (
              'Submit Ticket'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
