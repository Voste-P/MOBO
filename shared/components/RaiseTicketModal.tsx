import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';

interface RaiseTicketModalProps {
  open: boolean;
  onClose: () => void;
}

// Role-specific issue types (fallback if API fails)
const ROLE_ISSUE_TYPES: Record<string, readonly string[]> = {
  shopper: ['Cashback Delay', 'Wrong Amount', 'Order Issue', 'Product Issue', 'Delivery Problem', 'Refund Request', 'Other'],
  mediator: ['Commission Delay', 'Team Issue', 'Campaign Problem', 'Payout Issue', 'Buyer Complaint', 'Other'],
  agency: ['Brand Campaign Issue', 'Mediator Performance', 'Payout Delay', 'Technical Issue', 'Campaign Setup', 'Other'],
  brand: ['Campaign Setup', 'Agency Connection', 'Order Dispute', 'Payment Issue', 'Quality Concern', 'Other'],
};

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: 'text-slate-500 bg-slate-50 border-slate-200' },
  { value: 'medium', label: 'Medium', color: 'text-amber-600 bg-amber-50 border-amber-200' },
  { value: 'high', label: 'High', color: 'text-orange-600 bg-orange-50 border-orange-200' },
  { value: 'urgent', label: 'Urgent', color: 'text-red-600 bg-red-50 border-red-200' },
] as const;

export const RaiseTicketModal: React.FC<RaiseTicketModalProps> = ({ open, onClose }) => {
  const { user } = useAuth();
  const { toast } = useToast();

  const userRole = useMemo(() => {
    return String((user as any)?.role || (user as any)?.roles?.[0] || 'shopper');
  }, [user]);

  const issueTypes = useMemo(() => {
    return ROLE_ISSUE_TYPES[userRole] || ROLE_ISSUE_TYPES.shopper;
  }, [userRole]);

  const [issueType, setIssueType] = useState<string>('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<string>('medium');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && issueTypes.length > 0 && !issueType) {
      setIssueType(issueTypes[0]);
    }
  }, [open, issueTypes, issueType]);

  const reset = useCallback(() => {
    setIssueType(issueTypes[0] || '');
    setDescription('');
    setPriority('medium');
    setSubmitting(false);
  }, [issueTypes]);

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
        role: userRole,
        issueType,
        description: description.trim(),
        priority,
      });
      toast.success('Ticket submitted! Our team will review it shortly.');
      reset();
      onClose();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to raise ticket.'));
    } finally {
      setSubmitting(false);
    }
  }, [user, description, submitting, issueType, priority, userRole, toast, reset, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-2xl p-6 shadow-2xl animate-slide-up relative max-h-[90vh] overflow-y-auto scrollbar-styled"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          aria-label="Close"
          className="absolute top-4 right-4 p-2 bg-gray-100 rounded-full hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white z-10"
        >
          <X size={16} />
        </button>

        <h3 className="text-lg font-bold text-slate-900 mb-0.5 flex items-center gap-2">
          <AlertTriangle className="text-red-500" size={18} /> Raise a Ticket
        </h3>
        <p className="text-xs text-slate-500 mb-5">
          Choose the issue type that best describes your problem
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block mb-2">
              Issue Type
            </label>
            <div className="flex flex-wrap gap-2">
              {issueTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setIssueType(type)}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                    issueType === type
                      ? 'bg-red-50 text-red-600 border-red-200 shadow-sm'
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
              Priority
            </label>
            <div className="flex gap-2">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPriority(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    priority === opt.value ? opt.color + ' shadow-sm' : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block mb-2">
              Describe Your Issue
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-red-400 h-28 resize-none"
              placeholder="Please provide details about your issue..."
            />
            {description.length > 0 && (
              <p className="text-[10px] text-slate-400 text-right mt-1">{description.length}/2000</p>
            )}
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !description.trim() || !issueType}
            className="w-full py-3.5 bg-slate-900 text-white font-semibold rounded-xl flex items-center justify-center gap-2 hover:bg-slate-800 transition-all disabled:opacity-50 active:scale-[0.98]"
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
