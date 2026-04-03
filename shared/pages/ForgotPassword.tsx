'use client';

import React, { useState } from 'react';
import { Phone, ArrowRight, Lock, ShieldQuestion, CheckCircle, KeyRound, ArrowLeft } from 'lucide-react';
import { Button, Input } from '../components/ui';
import { getQuestionLabel } from '../utils/securityQuestions';
import { api } from '../services/api';
import { normalizeMobileTo10Digits } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';

interface ForgotPasswordProps {
  onBack: () => void;
  onSuccess: () => void;
  accentColor?: string;
}

type Step = 'mobile' | 'answers' | 'newPassword' | 'done';

const STEPS: Step[] = ['mobile', 'answers', 'newPassword'];

export const ForgotPassword: React.FC<ForgotPasswordProps> = ({ onBack, onSuccess }) => {
  const [step, setStep] = useState<Step>('mobile');
  const [mobile, setMobile] = useState('');
  const [questionIds, setQuestionIds] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (mobile.length < 10) {
      setError('Please enter a valid 10-digit mobile number.');
      return;
    }
    setIsLoading(true);
    try {
      const result = await api.auth.forgotPasswordLookup(mobile);
      if (result?.questionIds?.length >= 3) {
        setQuestionIds(result.questionIds);
        setStep('answers');
      } else {
        setError('Security questions not set for this account. Please contact support.');
      }
    } catch (err: unknown) {
      setError(formatErrorMessage(err, 'Unable to find account'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyAnswers = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    for (const qid of questionIds) {
      if (!answers[qid]?.trim()) {
        setError('Please answer all security questions.');
        return;
      }
    }
    setStep('newPassword');
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!newPassword || newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword.length > 200) {
      setError('Password must not exceed 200 characters.');
      return;
    }
    if (!/[A-Z]/.test(newPassword)) {
      setError('Password must contain at least one uppercase letter.');
      return;
    }
    if (!/[a-z]/.test(newPassword)) {
      setError('Password must contain at least one lowercase letter.');
      return;
    }
    if (!/[0-9]/.test(newPassword)) {
      setError('Password must contain at least one number.');
      return;
    }
    if (!/[^A-Za-z0-9]/.test(newPassword)) {
      setError('Password must contain at least one special character.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      const answerPayload = questionIds.map((qid) => ({
        questionId: qid,
        answer: answers[qid]!.trim(),
      }));
      await api.auth.forgotPasswordReset(mobile, answerPayload, newPassword);
      setStep('done');
    } catch (err: unknown) {
      setError(formatErrorMessage(err, 'Password reset failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const goBack = () => {
    setError('');
    if (step === 'mobile') onBack();
    else if (step === 'answers') setStep('mobile');
    else if (step === 'newPassword') setStep('answers');
  };

  /* ── Success Screen ── */
  if (step === 'done') {
    return (
      <div className="flex-1 flex flex-col bg-white min-h-[100dvh] relative px-6 py-12 overflow-y-auto scrollbar-styled items-center justify-center text-center">
        <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-6 ring-4 ring-emerald-50">
          <CheckCircle size={40} className="text-emerald-600" />
        </div>
        <h2 className="text-3xl font-extrabold text-gray-900 mb-3 tracking-tight">Password Reset!</h2>
        <p className="text-gray-500 mb-8 max-w-xs leading-relaxed">
          Your password has been successfully reset. You can now login with your new password.
        </p>
        <Button
          type="button"
          size="lg"
          className="w-full max-w-xs"
          onClick={onSuccess}
        >
          Go to Login
        </Button>
      </div>
    );
  }

  /* ── Main Form ── */
  return (
    <div className="flex-1 flex flex-col bg-white min-h-[100dvh] relative px-6 pt-10 pb-8 overflow-y-auto scrollbar-styled">
      {/* Back button */}
      <button
        type="button"
        onClick={goBack}
        className="flex items-center gap-1.5 text-gray-500 hover:text-gray-900 font-semibold text-sm mb-6 transition-colors self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 rounded-lg px-1 py-0.5"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center border border-amber-200 shrink-0">
            <KeyRound size={24} className="text-amber-700" />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-gray-900 tracking-tight">
              {step === 'mobile' && 'Forgot Password'}
              {step === 'answers' && 'Security Questions'}
              {step === 'newPassword' && 'New Password'}
            </h2>
            <p className="text-gray-500 text-sm font-medium">
              {step === 'mobile' && 'Enter your registered mobile number'}
              {step === 'answers' && 'Answer your security questions'}
              {step === 'newPassword' && 'Create a strong new password'}
            </p>
          </div>
        </div>
      </div>

      {/* Step indicator — uses static Tailwind classes instead of dynamic */}
      <div className="flex gap-2 mb-6">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              i <= STEPS.indexOf(step) ? 'bg-black' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="p-3 bg-red-50 text-red-600 text-xs rounded-2xl text-center font-bold border border-red-100 break-words whitespace-pre-line leading-relaxed animate-enter mb-4">
          {error}
        </div>
      )}

      {/* Step 1: Mobile */}
      {step === 'mobile' && (
        <form onSubmit={handleLookup} className="space-y-4 fade-in flex-1 flex flex-col" noValidate>
          <div className="flex-1">
            <Input
              label="Mobile Number"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              pattern="[0-9]{10}"
              placeholder="Enter your registered mobile"
              value={mobile}
              onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
              leftIcon={<Phone size={18} />}
              required
              autoComplete="tel"
            />
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            loading={isLoading}
            size="lg"
            className="w-full mt-auto"
            rightIcon={!isLoading ? <ArrowRight size={16} /> : undefined}
          >
            Continue
          </Button>
        </form>
      )}

      {/* Step 2: Security Question Answers — each question is clearly visible in a card */}
      {step === 'answers' && (
        <form onSubmit={handleVerifyAnswers} className="space-y-4 fade-in flex-1 flex flex-col" noValidate>
          <div className="flex-1 space-y-4">
            {questionIds.map((qid, idx) => (
              <div key={qid} className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                {/* Question label — large, bold, always visible */}
                <div className="flex items-start gap-2.5 mb-3">
                  <span className="flex items-center justify-center w-7 h-7 rounded-full bg-black text-white text-xs font-bold shrink-0 mt-0.5">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Question {idx + 1}</p>
                    <p className="text-[15px] font-bold text-gray-900 leading-snug">
                      {getQuestionLabel(qid)}
                    </p>
                  </div>
                </div>
                {/* Answer input */}
                <Input
                  label="Your Answer"
                  placeholder="Type your answer here..."
                  value={answers[qid] || ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [qid]: e.target.value }))}
                  leftIcon={<ShieldQuestion size={16} />}
                  required
                  autoCapitalize="none"
                  autoComplete="off"
                />
              </div>
            ))}
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            loading={isLoading}
            size="lg"
            className="w-full mt-4"
            rightIcon={!isLoading ? <ArrowRight size={16} /> : undefined}
          >
            Verify Answers
          </Button>
        </form>
      )}

      {/* Step 3: New Password */}
      {step === 'newPassword' && (
        <form onSubmit={handleResetPassword} className="space-y-4 fade-in flex-1 flex flex-col" noValidate>
          <div className="flex-1 space-y-4">
            <Input
              label="New Password"
              type="password"
              placeholder="New Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              leftIcon={<Lock size={18} />}
              required
              minLength={8}
              maxLength={200}
              autoComplete="new-password"
              hint="8+ chars: uppercase, lowercase, number & special"
            />
            <Input
              label="Confirm Password"
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              leftIcon={<Lock size={18} />}
              required
              minLength={8}
              maxLength={200}
              autoComplete="new-password"
            />
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            loading={isLoading}
            size="lg"
            className="w-full mt-4"
            rightIcon={!isLoading ? <CheckCircle size={16} /> : undefined}
          >
            Reset Password
          </Button>
        </form>
      )}
    </div>
  );
};
