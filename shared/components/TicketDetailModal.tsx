import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Send, MessageCircle, ArrowUpCircle, RotateCcw, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';
import type { Ticket, TicketComment } from '../types';

interface TicketDetailModalProps {
  open: boolean;
  onClose: () => void;
  ticket: Ticket | null;
  onRefresh: () => void;
}

const ESCALATION_PATH: Record<string, string> = {
  mediator: 'agency',
  brand: 'admin',
};

const statusColors: Record<string, string> = {
  Open: 'bg-amber-50 text-amber-600 border-amber-200',
  Resolved: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  Rejected: 'bg-red-50 text-red-600 border-red-200',
};

const roleColors: Record<string, string> = {
  shopper: 'text-blue-600',
  user: 'text-blue-600',
  mediator: 'text-violet-600',
  agency: 'text-emerald-600',
  brand: 'text-orange-600',
  admin: 'text-red-600',
  ops: 'text-red-600',
};

export default function TicketDetailModal({ open, onClose, ticket, onRefresh }: TicketDetailModalProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [orderDetails, setOrderDetails] = useState<any>(null);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  const userRole = user?.role || 'user';
  const isOpen = ticket?.status === 'Open';
  const isClosed = ticket?.status === 'Resolved' || ticket?.status === 'Rejected';
  const isOwner = ticket?.userId === user?.id;
  // Role hierarchy: higher-tier roles can manage lower-tier tickets
  const ROLE_LEVEL: Record<string, number> = { user: 0, shopper: 0, mediator: 1, agency: 2, brand: 3, admin: 4, ops: 4 };
  const userLevel = ROLE_LEVEL[userRole] ?? -1;
  const targetLevel = ROLE_LEVEL[ticket?.targetRole || ''] ?? 0;
  const canManageTarget = userLevel >= targetLevel;
  const isAdmin = userRole === 'admin';
  // Escalate: the targeted role can escalate, OR any higher-tier role can escalate (not admin, not owner)
  // Buyer/mediator tickets cannot be escalated beyond agency
  const ticketOriginRole = ((ticket as any)?.userRole || ticket?.role || '').toLowerCase();
  const isBuyerMediatorTicketAtAgency = ['shopper', 'user', 'mediator'].includes(ticketOriginRole) && ticket?.targetRole === 'agency';
  const canEscalate = isOpen && !isOwner && canManageTarget && !!ESCALATION_PATH[ticket?.targetRole || ''] && !isAdmin && !isBuyerMediatorTicketAtAgency;
  // Resolve/reject: ticket owner can always resolve/reject their own, OR targeted role+ can for any in-network ticket
  const canResolve = isOpen && (isOwner || canManageTarget || isAdmin) && !(userRole === 'user' && !isOwner);
  const canReopen = isClosed && (canManageTarget || isAdmin || isOwner);
  const canDelete = isClosed && isAdmin;

  const loadComments = useCallback(async () => {
    if (!ticket) return;
    setLoadingComments(true);
    try {
      const resp = await api.tickets.getComments(ticket.id);
      setComments(resp.comments || []);
    } catch {
      // Silently handle poll failures — comments stay as-is
    } finally {
      setLoadingComments(false);
    }
  }, [ticket]);

  useEffect(() => {
    if (open && ticket) {
      loadComments();
      setNewComment('');
      setResolutionNote('');
      setShowResolveForm(false);
      setOrderDetails(null);
      // Fetch full ticket details including order info
      api.tickets.getById(ticket.id).then((resp: any) => {
        if (resp.orderDetails) setOrderDetails(resp.orderDetails);
      }).catch(() => {});
    }
  }, [open, ticket, loadComments]);

  // Realtime: refresh comments on tickets.changed (no polling — SSE handles updates)
  useEffect(() => {
    if (!open || !ticket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeRealtime((msg) => {
      if (msg.type === 'tickets.changed') {
        // Debounce rapid SSE bursts
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; loadComments(); }, 600);
      }
    });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [open, ticket, loadComments]);

  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments]);

  if (!open || !ticket) return null;

  const handleAddComment = async () => {
    const msg = newComment.trim();
    if (!msg) return;
    setSubmittingComment(true);
    try {
      await api.tickets.addComment(ticket.id, msg);
      setNewComment('');
      await loadComments();
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to add comment.'));
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleResolve = async (status: 'Resolved' | 'Rejected') => {
    setActionLoading(status);
    try {
      await api.tickets.update(ticket.id, status, resolutionNote || undefined);
      toast.success(`Ticket ${status === 'Resolved' ? 'resolved' : 'rejected'} successfully.`);
      setShowResolveForm(false);
      setResolutionNote('');
      onRefresh();
      onClose();
    } catch (err: any) {
      const msg = formatErrorMessage(err, `Unable to ${status === 'Resolved' ? 'resolve' : 'reject'} this ticket. Please try again.`);
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleEscalate = async () => {
    setActionLoading('escalate');
    try {
      await api.tickets.escalate(ticket.id);
      toast.success(`Ticket escalated to ${ESCALATION_PATH[ticket?.targetRole || ''] || 'higher authority'} successfully.`);
      onRefresh();
      onClose();
    } catch (err: any) {
      const msg = formatErrorMessage(err, 'Unable to escalate this ticket. Please try again.');
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReopen = async () => {
    setActionLoading('reopen');
    try {
      await api.tickets.update(ticket.id, 'Open');
      toast.success('Ticket reopened successfully.');
      onRefresh();
      onClose();
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Unable to reopen this ticket. Please try again.'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    setActionLoading('delete');
    try {
      await api.tickets.delete(ticket.id);
      toast.success('Ticket deleted successfully.');
      onRefresh();
      onClose();
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Unable to delete this ticket. Please try again.'));
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-lg rounded-2xl shadow-2xl flex flex-col max-h-[85dvh] animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3 border-b border-zinc-100">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-extrabold text-slate-900 truncate">{ticket.issueType}</h2>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${statusColors[ticket.status] || statusColors.Open}`}>
                {ticket.status}
              </span>
            </div>
            <p className="text-[10px] text-zinc-400 mt-1">
              Ticket #{ticket.id.slice(-8)} &middot; Created {new Date(ticket.createdAt).toLocaleDateString('en-GB')}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 bg-gray-100 rounded-full hover:bg-gray-200 shrink-0 ml-2"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 scrollbar-styled">
          {/* Ticket info */}
          <div className="space-y-2">
            <div className="bg-zinc-50 rounded-xl p-3 text-xs text-zinc-700 leading-relaxed">
              {ticket.description}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
              <span>By: <strong className={roleColors[(ticket as any).userRole || ticket.role] || ''}>{ticket.userName}</strong> ({(ticket as any).userRole || ticket.role})</span>
              {(ticket.externalOrderId || ticket.orderId) && <span>Order: <strong>{ticket.externalOrderId || ticket.orderId}</strong></span>}
              {ticket.targetRole && <span>Assigned to: <strong>{ticket.targetRole}</strong></span>}
            </div>
            {ticket.resolutionNote && (
              <div className="text-[11px] text-green-700 bg-green-50 rounded-lg px-3 py-2">
                <span className="font-bold">Resolution: </span>{ticket.resolutionNote}
              </div>
            )}
            {isClosed && (ticket.resolvedByName || ticket.resolvedAt) && (
              <p className="text-[10px] text-zinc-400">
                {ticket.status === 'Resolved' ? 'Resolved' : 'Rejected'}
                {ticket.resolvedByName ? ` by ${ticket.resolvedByName}` : ''}
                {ticket.resolvedAt ? ` on ${new Date(ticket.resolvedAt).toLocaleDateString('en-GB')}` : ''}
              </p>
            )}
          </div>

          {/* Order Details */}
          {orderDetails && (
            <div className="space-y-1.5">
              <h3 className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Order Details</h3>
              <div className="bg-blue-50/60 rounded-xl p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                {orderDetails.externalOrderId && (
                  <div><span className="text-zinc-500">Order ID:</span> <strong className="text-zinc-800">{orderDetails.externalOrderId}</strong></div>
                )}
                {orderDetails.product && (
                  <div><span className="text-zinc-500">Product:</span> <strong className="text-zinc-800">{orderDetails.product}</strong></div>
                )}
                {orderDetails.platform && (
                  <div><span className="text-zinc-500">Platform:</span> <strong className="text-zinc-800">{orderDetails.platform}</strong></div>
                )}
                {orderDetails.brand && (
                  <div><span className="text-zinc-500">Brand:</span> <strong className="text-zinc-800">{orderDetails.brand}</strong></div>
                )}
                {orderDetails.unitPrice != null && (
                  <div><span className="text-zinc-500">Unit Price:</span> <strong className="text-zinc-800">₹{orderDetails.unitPrice}</strong></div>
                )}
                {orderDetails.quantity != null && (
                  <div><span className="text-zinc-500">Qty:</span> <strong className="text-zinc-800">{orderDetails.quantity}</strong></div>
                )}
                {orderDetails.total != null && (
                  <div><span className="text-zinc-500">Total:</span> <strong className="text-zinc-800">₹{orderDetails.total}</strong></div>
                )}
                {orderDetails.commission != null && (
                  <div><span className="text-zinc-500">Commission:</span> <strong className="text-zinc-800">₹{orderDetails.commission}</strong></div>
                )}
                {orderDetails.dealType && (
                  <div><span className="text-zinc-500">Deal Type:</span> <strong className="text-zinc-800">{orderDetails.dealType}</strong></div>
                )}
                {orderDetails.orderDate && (
                  <div><span className="text-zinc-500">Order Date:</span> <strong className="text-zinc-800">{new Date(orderDetails.orderDate).toLocaleDateString('en-GB')}</strong></div>
                )}
                {orderDetails.workflowStatus && (
                  <div><span className="text-zinc-500">Workflow:</span> <strong className="text-zinc-800">{orderDetails.workflowStatus}</strong></div>
                )}
                {orderDetails.affiliateStatus && (
                  <div><span className="text-zinc-500">Affiliate:</span> <strong className="text-zinc-800">{orderDetails.affiliateStatus}</strong></div>
                )}
                {orderDetails.paymentStatus && (
                  <div><span className="text-zinc-500">Payment:</span> <strong className="text-zinc-800">{orderDetails.paymentStatus}</strong></div>
                )}
                {orderDetails.mediator && (
                  <div><span className="text-zinc-500">Mediator:</span> <strong className="text-zinc-800">{orderDetails.mediator}</strong></div>
                )}
                {orderDetails.soldBy && (
                  <div><span className="text-zinc-500">Sold By:</span> <strong className="text-zinc-800">{orderDetails.soldBy}</strong></div>
                )}
              </div>
            </div>
          )}

          {/* Ticket activity timeline */}
          <div className="space-y-1.5">
            <h3 className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Activity</h3>
            <div className="relative pl-4 border-l-2 border-zinc-200 space-y-2">
              <div className="relative">
                <div className="absolute -left-[21px] top-0.5 w-2.5 h-2.5 rounded-full bg-blue-400 border-2 border-white" />
                <p className="text-[10px] text-zinc-600">
                  <strong className={roleColors[(ticket as any).userRole || ticket.role] || ''}>{ticket.userName}</strong> created this ticket
                  <span className="text-zinc-400 ml-1">{new Date(ticket.createdAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </p>
              </div>
              {ticket.targetRole && ticket.targetRole !== ((ticket as any).userRole === 'shopper' ? 'mediator' : ESCALATION_PATH[(ticket as any).userRole || '']) && (
                <div className="relative">
                  <div className="absolute -left-[21px] top-0.5 w-2.5 h-2.5 rounded-full bg-violet-400 border-2 border-white" />
                  <p className="text-[10px] text-zinc-600">
                    Escalated to <strong>{ticket.targetRole}</strong>
                  </p>
                </div>
              )}
              {isClosed && (
                <div className="relative">
                  <div className={`absolute -left-[21px] top-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${ticket.status === 'Resolved' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <p className="text-[10px] text-zinc-600">
                    <strong>{ticket.resolvedByName || 'System'}</strong> {ticket.status === 'Resolved' ? 'resolved' : 'rejected'} this ticket
                    {ticket.resolvedAt && <span className="text-zinc-400 ml-1">{new Date(ticket.resolvedAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Comments thread */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <MessageCircle size={14} className="text-zinc-400" />
              <h3 className="text-xs font-bold text-zinc-700">Comments ({comments.length})</h3>
            </div>
            {loadingComments ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={18} className="animate-spin text-zinc-300" />
              </div>
            ) : comments.length === 0 ? (
              <p className="text-[11px] text-zinc-400 text-center py-4">No comments yet. Start the conversation below.</p>
            ) : (
              <div className="space-y-2">
                {comments.map((c) => {
                  const isMe = c.userId === user?.id;
                  return (
                    <div key={c.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-xl px-3 py-2 ${isMe ? 'bg-slate-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 ${isMe ? 'justify-end' : ''}`}>
                          <span className={`text-[9px] font-bold ${isMe ? 'text-zinc-300' : (roleColors[c.role] || 'text-zinc-500')}`}>
                            {c.userName}
                          </span>
                          <span className={`text-[8px] ${isMe ? 'text-zinc-400' : 'text-zinc-400'}`}>
                            {c.role}
                          </span>
                        </div>
                        <p className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">{c.message}</p>
                        <p className={`text-[8px] mt-1 ${isMe ? 'text-zinc-400 text-right' : 'text-zinc-400'}`}>
                          {new Date(c.createdAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={commentsEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Comment input + Actions footer */}
        <div className="border-t border-zinc-100 p-4 space-y-3">
          {/* Comment input */}
          <div className="flex items-end gap-2">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write a comment..."
              className="flex-1 px-3 py-2 text-xs rounded-xl border border-zinc-200 bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-slate-300 resize-none"
              rows={2}
              maxLength={2000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAddComment();
                }
              }}
            />
            <button
              type="button"
              onClick={handleAddComment}
              disabled={!newComment.trim() || submittingComment}
              className="p-2.5 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              aria-label="Send comment"
            >
              {submittingComment ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>

          {/* Resolve/Reject form */}
          {showResolveForm && canResolve && (
            <div className="space-y-2 p-3 bg-zinc-50 rounded-xl border border-zinc-200">
              <textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                placeholder="Add a resolution/rejection note (optional)..."
                className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-200 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none"
                rows={2}
                maxLength={2000}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleResolve('Resolved')}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {actionLoading === 'Resolved' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Resolve
                </button>
                <button
                  type="button"
                  onClick={() => handleResolve('Rejected')}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 disabled:opacity-50"
                >
                  {actionLoading === 'Rejected' ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => { setShowResolveForm(false); setResolutionNote(''); }}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-zinc-400 hover:text-zinc-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {canResolve && !showResolveForm && (
              <button
                type="button"
                onClick={() => setShowResolveForm(true)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100"
              >
                <CheckCircle2 size={12} /> Resolve / Reject
              </button>
            )}
            {canEscalate && (
              <button
                type="button"
                onClick={handleEscalate}
                disabled={!!actionLoading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              >
                {actionLoading === 'escalate' ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpCircle size={12} />}
                Escalate to {ESCALATION_PATH[ticket?.targetRole || '']}
              </button>
            )}
            {canReopen && (
              <button
                type="button"
                onClick={handleReopen}
                disabled={!!actionLoading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
              >
                {actionLoading === 'reopen' ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Reopen
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={!!actionLoading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-zinc-50 border border-zinc-200 text-zinc-600 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
              >
                {actionLoading === 'delete' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
