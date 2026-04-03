import React, { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { Button, Input, Spinner } from '../components/ui';
import { SecurityQuestionsSetup, type SecurityQA } from '../components/SecurityQuestionsSetup';
import { ForgotPassword } from './ForgotPassword';
import { normalizeMobileTo10Digits } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';
import {
  Building2,
  ArrowRight,
  Lock,
  Phone,
  User as UserIcon,
  CheckCircle,
  ChevronLeft,
  Globe,
  Zap,
  ShieldCheck,
} from 'lucide-react';

interface AgencyAuthProps {
  onBack?: () => void;
}

export const AgencyAuthScreen: React.FC<AgencyAuthProps> = ({ onBack }) => {
  const [view, setView] = useState<'splash' | 'login' | 'register' | 'securityQuestions' | 'forgotPassword'>('splash');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [adminCode, setAdminCode] = useState('');

  const pendingRegRef = useRef<{ name: string; mobile: string; password: string; adminCode: string } | null>(null);

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
      if (u?.role !== 'agency') {
        logout();
        setError(`This account is a ${u?.role}. Please use the correct portal.`);
        setIsLoading(false);
        return;
      }
    } catch (err: any) {
      setError(formatErrorMessage(err, 'Login failed'));
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !mobile || !password || !adminCode) {
      setError('All fields required.');
      return;
    }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError('Password needs 8+ chars with uppercase, lowercase, number, and special character.');
      return;
    }
    setError('');
    pendingRegRef.current = { name, mobile, password, adminCode };
    setView('securityQuestions');
  };

  const handleSecurityQuestionsComplete = async (questions: SecurityQA[]) => {
    const reg = pendingRegRef.current;
    if (!reg) return;
    setIsLoading(true);
    setError('');
    try {
      await registerOps(reg.name, reg.mobile, reg.password, 'agency', reg.adminCode.toUpperCase(), questions);
    } catch (err: any) {
      setError(formatErrorMessage(err, 'Registration failed'));
      setView('register');
      setIsLoading(false);
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
        onBack={() => { setView('register'); setError(''); }}
      />
    );
  }

  if (view === 'splash') {
    return (
      <div className="flex min-h-[100dvh] w-full bg-zinc-950 text-white overflow-x-hidden relative font-sans">
        {/* Abstract Background */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-[-10%] left-[-10%] w-[60vw] h-[60vw] bg-purple-500/10 rounded-full blur-[150px] animate-pulse motion-reduce:animate-none"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] bg-lime-500/10 rounded-full blur-[150px]"></div>
          <div className="absolute inset-0 opacity-20 brightness-100 contrast-150 mix-blend-overlay" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.7\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")' }} />
        </div>

        {/* Content Container */}
        <div className="relative z-10 flex flex-col items-center justify-center w-full h-full p-8">
          {onBack && (
            <button
              onClick={onBack}
              className="absolute top-8 left-8 flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 rounded"
            >
              <ChevronLeft size={16} /> Return
            </button>
          )}

          <div className="w-24 h-24 bg-gradient-to-tr from-purple-400 to-indigo-500 rounded-3xl flex items-center justify-center shadow-2xl shadow-purple-500/20 mb-10 rotate-3 border-t border-white/20">
            <Building2 size={40} className="text-white" />
          </div>

          <h1 className="text-7xl font-extrabold text-center tracking-tighter mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
            BUZZMA<span className="text-purple-400">Ops</span>
          </h1>

          <p className="text-zinc-400 text-center max-w-lg text-lg leading-relaxed mb-12">
            The workforce management engine. Coordinate mediators, distribute inventory, and track
            network performance.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <button
              onClick={() => setView('login')}
              className="flex-1 bg-white text-black h-14 rounded-2xl font-bold text-sm hover:bg-zinc-200 transition-all active:scale-[0.98] shadow-lg flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              Enter Portal <ArrowRight size={16} />
            </button>
            <button
              onClick={() => setView('register')}
              className="flex-1 bg-zinc-900/50 backdrop-blur-md text-white border border-white/10 h-14 rounded-2xl font-bold text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              Register Agency
            </button>
          </div>

          <div className="mt-12 flex gap-8 text-zinc-500">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest">
              <Globe size={14} /> Network Wide
            </div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest">
              <Zap size={14} /> Instant Sync
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- SPLIT LAYOUT FOR FORMS ---
  return (
    <div className="flex min-h-[100dvh] w-full bg-white font-sans">
      {/* Left Visual Side */}
      <div className="hidden lg:flex lg:w-1/2 bg-zinc-950 relative overflow-hidden flex-col justify-between p-12 text-white">
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40vw] h-[40vw] bg-purple-600/20 rounded-full blur-[120px]"></div>
          <div className="absolute inset-0 opacity-20 mix-blend-overlay" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.7\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")' }} />
        </div>

        <div className="relative z-10">
          <button
            onClick={() => setView('splash')}
            className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 rounded"
          >
            <ArrowRight className="rotate-180" size={16} /> Back
          </button>
        </div>

        <div className="relative z-10 mb-12">
          <h2 className="text-5xl font-extrabold tracking-tight mb-6">
            Empower your
            <br />
            sales network.
          </h2>
          <div className="flex gap-3">
            <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-lg border border-white/5 text-sm font-medium">
              {'\u{1F680}'} Fast Distribution
            </div>
            <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-lg border border-white/5 text-sm font-medium">
              {'\u{1F465}'} Team Mgmt
            </div>
          </div>
        </div>
      </div>

      {/* Right Form Side */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-zinc-50">
        <div className="w-full max-w-md bg-white p-10 rounded-[2rem] shadow-xl border border-zinc-100">
          <div className="mb-8">
            <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center mb-4 shadow-lg shadow-purple-500/30 text-white">
              <Building2 size={24} />
            </div>
            <h2 className="text-2xl font-extrabold text-zinc-900 tracking-tight">
              {view === 'login' ? 'Agency Login' : 'New Agency'}
            </h2>
            <p className="text-zinc-500 text-sm mt-1">
              {view === 'login'
                ? 'Secure access for operation managers.'
                : 'Register your agency with an admin code.'}
            </p>
          </div>

          <form onSubmit={view === 'login' ? handleLogin : handleRegister} className="space-y-4">
            {error && (
              <div role="alert" className="p-4 bg-red-50 text-red-600 text-xs font-bold rounded-xl flex items-center gap-2 border border-red-100 animate-enter">
                {error}
              </div>
            )}

            {view === 'register' && (
              <Input
                label="Agency Name"
                placeholder="e.g. Alpha Growth"
                value={name}
                onChange={(e) => setName(e.target.value)}
                leftIcon={<UserIcon size={18} />}
                required
                autoCapitalize="words"
              />
            )}

            <Input
              label="Mobile"
              type="tel"
              inputMode="numeric"
              placeholder="9000000000"
              value={mobile}
              onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
              maxLength={10}
              pattern="[0-9]{10}"
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
                label="Admin Invite Code"
                type="text"
                placeholder="e.g. INV-XXXX"
                value={adminCode}
                onChange={(e) => setAdminCode(e.target.value.toUpperCase())}
                leftIcon={<ShieldCheck size={18} />}
                className="font-mono tracking-widest uppercase"
                required
                autoCapitalize="characters"
              />
            )}

            <Button
              type="submit"
              disabled={isLoading}
              size="lg"
              className="w-full mt-6 bg-black text-white hover:bg-purple-600 hover:text-white focus-visible:ring-purple-300"
              rightIcon={
                isLoading ? (
                  <Spinner className="w-5 h-5 text-current" />
                ) : view === 'login' ? (
                  <ArrowRight size={16} />
                ) : (
                  <CheckCircle size={16} />
                )
              }
            >
              {view === 'login' ? 'Login to Ops' : 'Initialize Agency'}
            </Button>

            {view === 'login' && (
              <button
                type="button"
                className="w-full text-center text-xs text-zinc-500 hover:text-purple-500 mt-2 transition-colors"
                onClick={() => { setView('forgotPassword'); setError(''); }}
              >
                Forgot Password?
              </button>
            )}
          </form>

          <p className="text-center mt-6 text-xs text-zinc-400 font-medium">
            {view === 'login' ? 'Need to setup a new agency?' : 'Already verified?'}
            <button
              onClick={() => setView(view === 'login' ? 'register' : 'login')}
              className="text-black font-bold ml-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white rounded"
            >
              {view === 'login' ? 'Register Here' : 'Login Here'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};
