'use client';

import React, { useState, useEffect } from 'react';
import { ShieldQuestion, ArrowLeft, CheckCircle } from 'lucide-react';
import { Button, Input } from './ui';
import { api } from '../services/api';
import { SECURITY_QUESTIONS } from '../utils/securityQuestions';

export interface SecurityQA {
  questionId: number;
  answer: string;
}

interface SecurityQuestionsSetupProps {
  onComplete: (questions: SecurityQA[]) => void;
  onBack: () => void;
}

export const SecurityQuestionsSetup: React.FC<SecurityQuestionsSetupProps> = ({ onComplete, onBack }) => {
  const [questions, setQuestions] = useState<{ id: number; label: string }[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(true);
  const [selectedIds, setSelectedIds] = useState<[number, number, number]>([0, 0, 0]);
  const [answers, setAnswers] = useState<[string, string, string]>(['', '', '']);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.auth.getSecurityQuestionTemplates()
      .then((res) => {
        if (!cancelled) {
          const list = res?.templates?.map((t) => ({ id: t.questionId, label: t.label })) ?? [];
          setQuestions(list.length > 0 ? list : SECURITY_QUESTIONS);
        }
      })
      .catch(() => {
        if (!cancelled) setQuestions(SECURITY_QUESTIONS);
      })
      .finally(() => { if (!cancelled) setLoadingQuestions(false); });
    return () => { cancelled = true; };
  }, []);

  const getAvailableQuestions = (slotIndex: number) => {
    const usedIds = selectedIds.filter((_, i) => i !== slotIndex && selectedIds[i] !== 0);
    return questions.filter((q) => !usedIds.includes(q.id));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    for (let i = 0; i < 3; i++) {
      if (!selectedIds[i]) {
        setError(`Please select security question ${i + 1}.`);
        return;
      }
      if (!answers[i].trim()) {
        setError(`Please answer security question ${i + 1}.`);
        return;
      }
      if (answers[i].trim().length < 2) {
        setError(`Answer for question ${i + 1} must be at least 2 characters.`);
        return;
      }
    }

    if (new Set(selectedIds).size < 3) {
      setError('Please select 3 different security questions.');
      return;
    }

    onComplete(
      selectedIds.map((qid, i) => ({
        questionId: qid,
        answer: answers[i],
      }))
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-white relative px-6 pt-10 pb-8 overflow-y-auto scrollbar-styled" style={{ minHeight: '100dvh' }}>
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-gray-500 hover:text-gray-900 font-semibold text-sm mb-6 transition-colors self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 rounded-lg px-1 py-0.5"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 bg-lime-100 rounded-2xl flex items-center justify-center border border-lime-200 shrink-0">
            <ShieldQuestion size={24} className="text-lime-700" />
          </div>
          <div>
            <h2 className="text-2xl font-extrabold text-gray-900 tracking-tight">Security Questions</h2>
            <p className="text-gray-500 text-sm font-medium">Used to recover your password if forgotten</p>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 bg-red-50 text-red-600 text-xs rounded-2xl text-center font-bold border border-red-100 break-words whitespace-pre-line leading-relaxed animate-enter mb-4">
          {error}
        </div>
      )}

      {loadingQuestions ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin h-8 w-8 border-4 border-lime-400 border-t-transparent rounded-full" />
        </div>
      ) : (
      <form onSubmit={handleSubmit} className="space-y-5 fade-in flex-1 flex flex-col" noValidate>
        <div className="flex-1 space-y-4">
          {[0, 1, 2].map((idx) => {
            const selectedQ = questions.find((q) => q.id === selectedIds[idx]);
            return (
              <div key={idx} className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-black text-white text-xs font-bold shrink-0">
                    {idx + 1}
                  </span>
                  <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                    Security Question
                  </label>
                </div>
                <select
                  value={selectedIds[idx]}
                  onChange={(e) => {
                    const newIds = [...selectedIds] as [number, number, number];
                    newIds[idx] = Number(e.target.value);
                    setSelectedIds(newIds);
                  }}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-lime-400/60 focus:border-transparent mb-3 appearance-none cursor-pointer"
                  required
                >
                  <option value={0} disabled>Select a question...</option>
                  {getAvailableQuestions(idx).map((q) => (
                    <option key={q.id} value={q.id}>{q.label}</option>
                  ))}
                </select>
                {/* Selected question displayed prominently so user knows what they're answering */}
                {selectedQ && (
                  <div className="bg-black/5 border border-black/10 rounded-xl px-3 py-2.5 mb-3">
                    <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Your question:</p>
                    <p className="text-sm font-bold text-gray-900 leading-snug">
                      {selectedQ.label}
                    </p>
                  </div>
                )}
                <Input
                  label={selectedQ ? 'Your Answer' : undefined}
                  placeholder={selectedQ ? 'Type your answer here...' : 'Select a question first'}
                  value={answers[idx]}
                  onChange={(e) => {
                    const newAnswers = [...answers] as [string, string, string];
                    newAnswers[idx] = e.target.value;
                    setAnswers(newAnswers);
                  }}
                  leftIcon={<ShieldQuestion size={16} />}
                  required
                  autoCapitalize="none"
                  disabled={!selectedQ}
                />
              </div>
            );
          })}
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3 text-xs text-amber-900 font-medium">
          <strong>Remember:</strong> These answers are case-insensitive but must be exact. You&apos;ll need them to reset your password.
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full mt-2"
          rightIcon={<CheckCircle size={16} />}
        >
          Save &amp; Continue
        </Button>
      </form>
      )}
    </div>
  );
};
