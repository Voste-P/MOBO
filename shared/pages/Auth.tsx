import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Bot, ArrowRight, Lock, User, Phone, Hash, ChevronLeft } from 'lucide-react';
import { Button, Input, AnimatedView } from '../components/ui';
import { SecurityQuestionsSetup, type SecurityQA } from '../components/SecurityQuestionsSetup';
import { ForgotPassword } from './ForgotPassword';
import { normalizeMobileTo10Digits } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';

interface AuthScreenProps {
  onBack?: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onBack }) => {
  const [view, setView] = useState<'splash' | 'login' | 'register' | 'securityQuestions' | 'forgotPassword'>('splash');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mediatorCode, setMediatorCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Temporarily stored registration data while user sets up security questions
  const pendingRegRef = useRef<{ name: string; mobile: string; password: string; mediatorCode: string } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const { login, register, logout } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Basic validation
    if (mobile.length < 10) {
      setError('Please enter a valid mobile number (10 digits).');
      return;
    }

    if (!password || password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password.length > 200) {
      setError('Password must not exceed 200 characters.');
      return;
    }

    if (view === 'register') {
      if (!/[A-Z]/.test(password)) {
        setError('Password must contain at least one uppercase letter.');
        return;
      }
      if (!/[a-z]/.test(password)) {
        setError('Password must contain at least one lowercase letter.');
        return;
      }
      if (!/[0-9]/.test(password)) {
        setError('Password must contain at least one number.');
        return;
      }
      if (!/[^A-Za-z0-9]/.test(password)) {
        setError('Password must contain at least one special character.');
        return;
      }
    }

    if (view === 'register') {
      if (!name.trim()) {
        setError('Please enter your full name.');
        return;
      }
      if (!mediatorCode.trim()) {
          setError('Mediator Code / Invite Code is required to create an account.');
        return;
      }
    }

    setIsLoading(true);

    try {
      if (view === 'login') {
        const u = await login(mobile, password);
        if (u?.role !== 'user') {
          const portal = u.role === 'brand' ? 'Brand Portal' : u.role === 'admin' ? 'Admin Portal' : 'Partner Ops Portal';
          if (mountedRef.current) setError(`This account is a ${u.role}. Please use the ${portal}.`);
          logout();
          return;
        }
      } else {
        // Store registration data and go to security questions step
        pendingRegRef.current = { name, mobile, password, mediatorCode };
        if (mountedRef.current) {
          setIsLoading(false);
          setView('securityQuestions');
        }
        return;
      }
    } catch (err: any) {
      if (mountedRef.current) setError(formatErrorMessage(err, 'Authentication failed'));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  };

  const handleSecurityQuestionsComplete = async (questions: SecurityQA[]) => {
    const reg = pendingRegRef.current;
    if (!reg) return;

    setIsLoading(true);
    setError('');
    try {
      await register(reg.name, reg.mobile, reg.password, reg.mediatorCode, questions);
    } catch (err: any) {
      if (mountedRef.current) {
        setError(formatErrorMessage(err, 'Registration failed'));
        setView('register');
      }
    } finally {
      if (mountedRef.current) setIsLoading(false);
      pendingRegRef.current = null;
    }
  };

  // Forgot Password Flow
  if (view === 'forgotPassword') {
    return (
      <AnimatedView viewKey="forgotPassword" variant="slideRight">
        <ForgotPassword
          onBack={() => { setView('login'); setError(''); }}
          onSuccess={() => { setView('login'); setError(''); }}
        />
      </AnimatedView>
    );
  }

  // Security Questions Setup (after registration form submit)
  if (view === 'securityQuestions') {
    return (
      <AnimatedView viewKey="securityQuestions" variant="slideUp">
        <SecurityQuestionsSetup
          onComplete={handleSecurityQuestionsComplete}
          onBack={() => setView('register')}
        />
      </AnimatedView>
    );
  }

  // 1. Splash Screen (Dark Theme)
  if (view === 'splash') {
    return (
      <AnimatedView viewKey="splash" variant="fade">
      <div className="flex-1 flex flex-col bg-black text-white relative overflow-x-hidden pb-[env(safe-area-inset-bottom)]" style={{ minHeight: 'calc(100dvh - var(--banner-h, 0px))' }}>
        {/* Background Effects */}
        <div className="absolute top-[-20%] right-[-20%] w-[500px] h-[500px] bg-lime-500/20 rounded-full blur-[120px] pointer-events-none animate-pulse motion-reduce:animate-none"></div>
        <div className="absolute bottom-[-10%] left-[-10%] w-[300px] h-[300px] bg-lime-600/15 rounded-full blur-[100px] pointer-events-none"></div>

        {/* Back Navigation */}
        {onBack && (
          <div className="absolute top-6 left-6 z-50">
            <button
              onClick={onBack}
              className="flex items-center gap-2 text-white/50 hover:text-white font-bold text-sm bg-white/10 px-4 py-2 rounded-full backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              <ChevronLeft size={16} /> Home
            </button>
          </div>
        )}

        {/* Content */}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-between p-8 pt-24 pb-12">
          <div className="flex flex-col items-center">
            <div className="w-24 h-24 bg-gradient-to-br from-lime-300 to-lime-500 rounded-[2.5rem] flex items-center justify-center shadow-[0_0_60px_rgba(132,204,22,0.3)] mb-12 rotate-6 border-t border-white/30 animate-[bounce_3s_infinite_ease-in-out] motion-reduce:animate-none">
              <Bot size={48} className="text-black" />
            </div>

            <h1 className="text-5xl font-extrabold leading-[1] text-center tracking-tight mb-6 drop-shadow-lg">
              Your AI <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-lime-300 to-lime-500">
                Deal Genius
              </span>
            </h1>

            <p className="text-gray-400 text-center max-w-[280px] leading-relaxed text-sm font-medium">
              Smarter shopping starts here. Track orders, find deals, and save money.
            </p>
          </div>

          <div className="w-full space-y-5">
            <button
              onClick={() => setView('login')}
              className="w-full bg-white text-black font-bold py-5 rounded-[2rem] shadow-[0_10px_40px_rgba(255,255,255,0.1)] hover:bg-gray-100 transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-lg group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Get Started
              <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
            </button>
           
          </div>
        </div>
      </div>
      </AnimatedView>
    );
  }

  // 2. Login / Register Form
  return (
    <AnimatedView viewKey={view} variant="slideUp">
    <div className="flex-1 flex flex-col bg-white relative px-6 pt-10 pb-8 overflow-y-auto scrollbar-styled" style={{ minHeight: 'calc(100dvh - var(--banner-h, 0px))' }}>
      <div className="mb-8">
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => setView('splash')}
          aria-label="Back"
          className="mb-8 rounded-full"
        >
          <ArrowRight className="rotate-180" size={20} />
        </Button>
        <h2 className="text-4xl font-extrabold text-gray-900 mb-2 tracking-tight">
          {view === 'login' ? 'Welcome Back' : 'Join BUZZMA'}
        </h2>
        <p className="text-gray-500 text-lg font-medium">
          {view === 'login' ? 'Enter your mobile to sign in.' : 'Create your free account.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 fade-in" noValidate>
        {error && (
          <div role="alert" className="p-3 bg-red-50 text-red-600 text-xs rounded-2xl text-center font-bold border border-red-100 break-words whitespace-pre-line leading-relaxed animate-enter">
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
          inputMode="numeric"
          maxLength={10}
          pattern="[0-9]{10}"
          placeholder="Mobile Number"
          value={mobile}
          onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
          leftIcon={<Phone size={18} />}
          required
          autoComplete="tel"
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
            label="Invite Code"
            placeholder="Invite Code (from Mediator)"
            value={mediatorCode}
            onChange={(e) => setMediatorCode(e.target.value)}
            leftIcon={<Hash size={18} />}
            autoCapitalize="characters"
            required
          />
        )}

        <Button
          type="submit"
          disabled={isLoading}
          loading={isLoading}
          size="lg"
          className="mt-6 w-full"
          rightIcon={
            !isLoading ? <ArrowRight size={16} /> : undefined
          }
        >
          {view === 'login' ? 'Sign In' : 'Create Account'}
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

      <div className="mt-auto text-center pb-8 pt-4">
        <p className="text-gray-400 font-medium text-sm">
          {view === 'login' ? 'New here? ' : 'Have an account? '}
          <button
            onClick={() => {
              setView(view === 'login' ? 'register' : 'login');
              setError('');
              setName('');
              setMobile('');
              setPassword('');
              setMediatorCode('');
            }}
            className="text-black font-bold hover:underline ml-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white rounded"
          >
            {view === 'login' ? 'Create Account' : 'Login'}
          </button>
        </p>
      </div>
    </div>
    </AnimatedView>
  );
};
