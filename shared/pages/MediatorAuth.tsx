import React, { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { Users, ArrowRight, Lock, User, Phone, CheckCircle, ChevronLeft, Clock } from 'lucide-react';
import { Button, Input, Spinner } from '../components/ui';
import { SecurityQuestionsSetup, type SecurityQA } from '../components/SecurityQuestionsSetup';
import { ForgotPassword } from './ForgotPassword';
import { normalizeMobileTo10Digits } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';

interface MediatorAuthProps {
  onBack?: () => void;
}

export const MediatorAuthScreen: React.FC<MediatorAuthProps> = ({ onBack }) => {
  const [view, setView] = useState<'splash' | 'login' | 'register' | 'pending' | 'securityQuestions' | 'forgotPassword'>('splash');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string>('');

  // Form State
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [agencyCode, setAgencyCode] = useState('');

  const pendingRegRef = useRef<{ name: string; mobile: string; password: string; agencyCode: string } | null>(null);

  const { login, registerOps, logout } = useAuth();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password || password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password.length > 200) {
      setError('Password must not exceed 200 characters.');
      return;
    }
    setIsLoading(true);
    try {
      const u = await login(mobile, password);
      if (u?.role !== 'mediator') {
        logout();
        setError(`This account is a ${u?.role}. Please use the correct portal.`);
        setIsLoading(false);
        return;
      }
    } catch (err: any) {
      const code = (err as any)?.code;
      if (code === 'USER_NOT_ACTIVE') {
        setPendingMessage(
          'Your account is not active yet. If you joined using an agency code, please wait for agency approval.'
        );
        setView('pending');
        setIsLoading(false);
        return;
      }
      setError(formatErrorMessage(err, 'Login failed'));
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !mobile || !password || !agencyCode) {
      setError('All fields required.');
      return;
    }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError('Password needs 8+ chars with uppercase, lowercase, number, and special character.');
      return;
    }
    // Store data and go to security questions step
    pendingRegRef.current = { name, mobile, password, agencyCode };
    setError('');
    setView('securityQuestions');
  };

  const handleSecurityQuestionsComplete = async (questions: SecurityQA[]) => {
    const reg = pendingRegRef.current;
    if (!reg) return;

    setIsLoading(true);
    setError('');
    try {
      const result = await registerOps(reg.name, reg.mobile, reg.password, 'mediator', reg.agencyCode.toUpperCase(), questions);

      if (result && typeof result === 'object' && 'pendingApproval' in result && result.pendingApproval) {
        const msg = (result as any)?.message;
        setPendingMessage(
          typeof msg === 'string' && msg.trim().length
            ? msg
            : 'Request sent to agency for approval. Your account will be activated after approval.'
        );
        setView('pending');
        setIsLoading(false);
        return;
      }
    } catch (err: any) {
      setError(formatErrorMessage(err, 'Registration failed'));
      setView('register');
    } finally {
      setIsLoading(false);
      pendingRegRef.current = null;
    }
  };

  if (view === 'forgotPassword') {
    return (
      <ForgotPassword
        onBack={() => { setView('login'); setError(''); }}
        onSuccess={() => { setView('login'); setError(''); }}
      />
    );
  }

  if (view === 'securityQuestions') {
    return (
      <SecurityQuestionsSetup
        onComplete={handleSecurityQuestionsComplete}
        onBack={() => setView('register')}
      />
    );
  }

  if (view === 'pending') {
    return (
      <div className="flex-1 flex flex-col bg-white min-h-[100dvh] relative px-6 pt-10 pb-8 overflow-y-auto scrollbar-styled">
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => {
            setView('splash');
            setPendingMessage('');
          }}
          aria-label="Back"
          className="mb-8 rounded-full"
        >
          <ArrowRight className="rotate-180" size={18} />
        </Button>

        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center border border-blue-100">
            <Clock size={22} className="text-blue-700" />
          </div>
          <div>
            <h2 className="text-3xl font-extrabold text-zinc-900">Approval Pending</h2>
            <p className="text-zinc-500 mt-1 font-medium">
              Your request has been sent to the agency.
            </p>
          </div>
        </div>

        <div className="bg-blue-50/60 border border-blue-100 rounded-2xl p-4 text-sm text-blue-900 font-bold">
          {pendingMessage || 'Request sent to agency for approval. Please wait.'}
        </div>

        <div className="mt-6 space-y-3 text-sm text-zinc-600 font-medium">
          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
            <div className="font-extrabold text-zinc-900 mb-1">What happens next?</div>
            <div>Agency will approve or reject your request from their dashboard.</div>
          </div>
          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
            <div className="font-extrabold text-zinc-900 mb-1">After approval</div>
            <div>You can login using your mobile number and password.</div>
          </div>
        </div>

        <div className="mt-8 space-y-3">
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => {
              setView('login');
              setPendingMessage('');
              setError('');
            }}
          >
            Go to Login
          </Button>

          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full"
            onClick={() => {
              setView('register');
              setPendingMessage('');
              setError('');
              setPassword('');
            }}
          >
            Edit Details
          </Button>
        </div>
      </div>
    );
  }
  if (view === 'splash') {
    return (
      <div className="flex-1 flex flex-col bg-zinc-900 text-white relative overflow-x-hidden min-h-[100dvh] pb-[env(safe-area-inset-bottom)]">
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-800 to-black"></div>
        {onBack && (
          <div className="absolute top-6 left-6 z-50">
            <button
              onClick={onBack}
              className="flex items-center gap-2 text-white/50 hover:text-white font-bold text-xs bg-white/10 px-3 py-1.5 rounded-full backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              <ChevronLeft size={14} /> Back
            </button>
          </div>
        )}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-between p-8 pt-32 pb-12">
          <div className="flex flex-col items-center">
            <div className="w-24 h-24 bg-lime-400 rounded-[2.5rem] flex items-center justify-center shadow-[0_0_60px_rgba(163,230,53,0.3)] mb-8 rotate-6">
              <Users size={40} className="text-black" />
            </div>
            <h1 className="text-4xl font-extrabold text-center tracking-tight mb-4">
              Mediator <span className="text-lime-400">App</span>
            </h1>
            <p className="text-zinc-400 text-center max-w-[260px] text-sm font-medium">
              Publish deals, verify orders, and earn commissions.
            </p>
          </div>
          <div className="w-full space-y-4">
            <button
              onClick={() => setView('login')}
              className="w-full bg-white text-black font-bold py-5 rounded-[2rem] shadow-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2 text-lg active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Login <ArrowRight size={20} />
            </button>
            <button
              onClick={() => setView('register')}
              className="w-full bg-zinc-800 text-white font-bold py-5 rounded-[2rem] border border-white/10 hover:bg-zinc-700 transition-all flex items-center justify-center gap-2 text-lg active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Join an Agency
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white min-h-[100dvh] relative px-6 pt-10 pb-8 overflow-y-auto scrollbar-styled">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        onClick={() => setView('splash')}
        aria-label="Back"
        className="mb-8 rounded-full"
      >
        <ArrowRight className="rotate-180" size={18} />
      </Button>
      <h2 className="text-3xl font-extrabold text-zinc-900 mb-2">
        {view === 'login' ? 'Welcome Back' : 'Join Team'}
      </h2>
      <p className="text-zinc-500 mb-8">
        {view === 'login' ? 'Login to your workspace.' : 'Enter details to get started.'}
      </p>

      <form onSubmit={view === 'login' ? handleLogin : handleRegister} className="space-y-4">
        {error && (
          <div role="alert" className="p-3 bg-red-50 text-red-600 text-sm rounded-xl font-bold text-center border border-red-100 animate-enter">
            {error}
          </div>
        )}

        {view === 'register' && (
          <Input
            label="Full Name"
            placeholder="Full Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            leftIcon={<User size={18} />}
            required
            autoCapitalize="words"
            autoComplete="name"
          />
        )}

        <Input
          label="Mobile"
          type="tel"
          placeholder="Mobile Number"
          value={mobile}
          onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
          leftIcon={<Phone size={18} />}
          required
          autoComplete="tel"
          inputMode="numeric"
          maxLength={10}
          pattern="[0-9]{10}"
        />

        <Input
          label="Password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          leftIcon={<Lock size={18} />}
          required
          minLength={8}
          maxLength={200}
          autoComplete={view === 'login' ? 'current-password' : 'new-password'}
          hint={view === 'register' ? '8+ chars: uppercase, lowercase, number & special' : undefined}
        />

        {view === 'register' && (
          <Input
            label="Agency Code"
            type="text"
            placeholder="Agency Code"
            value={agencyCode}
            onChange={(e) => setAgencyCode(e.target.value)}
            leftIcon={<CheckCircle size={18} />}
            required
            autoCapitalize="characters"
          />
        )}

        <Button type="submit" disabled={isLoading} size="lg" className="w-full mt-4">
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Spinner className="w-5 h-5 text-white" /> Please wait
            </span>
          ) : view === 'login' ? (
            'Login'
          ) : (
            'Register'
          )}
        </Button>

        {view === 'login' && (
          <button
            type="button"
            onClick={() => { setView('forgotPassword'); setError(''); }}
            className="w-full text-center text-sm text-gray-500 font-bold hover:text-black transition-colors mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white rounded py-1"
          >
            Forgot Password?
          </button>
        )}
      </form>
    </div>
  );
};
