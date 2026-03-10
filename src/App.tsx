import React, { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Smartphone, 
  LogOut, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  ShieldCheck,
  Phone,
  ArrowRight,
  Bot,
  Zap,
  Copy,
  Check,
  LayoutDashboard,
  PlusCircle,
  Database,
  HardDrive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Types
interface User {
  id: string;
  email: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>(() => {
    const saved = localStorage.getItem('auth');
    return saved ? JSON.parse(saved) : { token: null, user: null };
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [sessions, setSessions] = useState<any[]>([]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [prefix, setPrefix] = useState('.');
  const [isPublic, setIsPublic] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'add'>('dashboard');
  const [copied, setCopied] = useState(false);
  const [watchdogStatus, setWatchdogStatus] = useState('active');
  const [isInitializing, setIsInitializing] = useState(!auth.token);
  const isVercel = window.location.hostname.includes('vercel.app');
  const isRender = window.location.hostname.includes('onrender.com');

  useEffect(() => {
    // Auto-login if not authenticated
    if (!auth.token) {
      handleGuestLogin();
    }
  }, []);

  useEffect(() => {
    if (auth.token) {
      localStorage.setItem('auth', JSON.stringify(auth));
      const newSocket = io();
      setSocket(newSocket);

      newSocket.on('connect', () => {
        newSocket.emit('join', auth.user?.id);
      });

      newSocket.on('status', (data) => {
        setSessions(prev => {
          const index = prev.findIndex(s => s.phoneNumber === data.phoneNumber);
          if (index !== -1) {
            const newSessions = [...prev];
            newSessions[index] = { ...newSessions[index], status: data.status };
            return newSessions;
          }
          return prev;
        });
      });

      newSocket.on('pairing-code', (data) => {
        setSessions(prev => {
          const index = prev.findIndex(s => s.phoneNumber === data.phoneNumber);
          if (index !== -1) {
            const newSessions = [...prev];
            newSessions[index] = { ...newSessions[index], pairingCode: data.code };
            return newSessions;
          }
          return prev;
        });
      });

      fetchSessions();

      return () => {
        newSocket.disconnect();
      };
    } else {
      localStorage.removeItem('auth');
    }
  }, [auth.token]);

  const fetchSessions = async () => {
    if (!auth.token) return;
    try {
      const res = await fetch('/api/whatsapp/status', {
        headers: { Authorization: `Bearer ${auth.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.debug('Status fetch failed');
    }
  };

  const handleGuestLogin = async () => {
    setLoading(true);
    setError('');
    try {
      // First check if server is alive
      const healthRes = await fetch('/api/health').catch(() => null);
      if (!healthRes || !healthRes.ok) {
        throw new Error('SERVER_DOWN');
      }

      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        setAuth(data);
      } else {
        setError(data.error || 'Guest login failed');
      }
    } catch (e: any) {
      if (e.message === 'SERVER_DOWN') {
        setError('Le serveur ne répond pas. Si vous venez de déployer, attendez 1-2 minutes que le serveur démarre.');
      } else {
        setError('Erreur de connexion. Vérifiez votre statut internet ou serveur.');
      }
    } finally {
      setLoading(false);
      setIsInitializing(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/signup';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (res.status === 404) {
        setError('API not found. If deployed on Netlify, please ensure you have a backend server running.');
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setAuth(data);
      } else {
        setError(data.error || 'Authentication failed');
      }
    } catch (e) {
      setError('Connection failed. Check your internet or server status.');
    } finally {
      setLoading(false);
    }
  };

  const connectWhatsApp = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify({ 
          phoneNumber,
          prefix,
          mode: isPublic ? 'public' : 'private'
        })
      });
      const data = await res.json();
      if (res.ok) {
        // Add or update session in local state
        setSessions(prev => {
          const cleanNumber = phoneNumber.replace(/\D/g, '');
          const index = prev.findIndex(s => s.phoneNumber === cleanNumber);
          const newSession = { 
            phoneNumber: cleanNumber, 
            status: 'connecting', 
            pairingCode: data.pairingCode,
            prefix,
            mode: isPublic ? 'public' : 'private'
          };
          if (index !== -1) {
            const newSessions = [...prev];
            newSessions[index] = newSession;
            return newSessions;
          }
          return [...prev, newSession];
        });
        setPhoneNumber('');
        setShowAddAccount(false);
      } else {
        setError(data.error);
      }
    } catch (e) {
      setError('Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  const restartBot = async (num: string) => {
    setSessions(prev => prev.map(s => s.phoneNumber === num ? { ...s, status: 'connecting' } : s));
    try {
      await fetch('/api/whatsapp/restart', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}` 
        },
        body: JSON.stringify({ phoneNumber: num })
      });
      setTimeout(fetchSessions, 2000);
    } catch (e) {
      console.error('Failed to restart');
    }
  };

  const reanimateBot = async (num: string, prefix: string, mode: string) => {
    setSessions(prev => prev.map(s => s.phoneNumber === num ? { ...s, status: 'connecting' } : s));
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify({ 
          phoneNumber: num,
          prefix,
          mode
        })
      });
      if (!res.ok) throw new Error();
      setTimeout(fetchSessions, 2000);
    } catch (e) {
      console.error('Failed to reanimate');
      fetchSessions();
    }
  };

  const disconnect = async (num: string) => {
    try {
      await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}` 
        },
        body: JSON.stringify({ phoneNumber: num })
      });
      setSessions(prev => prev.filter(s => s.phoneNumber !== num));
    } catch (e) {
      console.error('Failed to disconnect');
    }
  };

  const updateSettings = async (num: string, statusReaction: boolean, statusReactionEmoji: string, autoReact: boolean, autoReactEmoji: string) => {
    try {
      const res = await fetch('/api/whatsapp/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify({ 
          phoneNumber: num,
          statusReaction,
          statusReactionEmoji,
          autoReact,
          autoReactEmoji
        })
      });
      if (res.ok) {
        setSessions(prev => prev.map(s => s.phoneNumber === num ? { ...s, statusReaction, statusReactionEmoji, autoReact, autoReactEmoji } : s));
      }
    } catch (e) {
      console.error('Failed to update settings');
    }
  };

  const copyToClipboard = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isInitializing || !auth.token) {
    return (
      <div className="min-h-screen bg-[#0F172A] text-white flex flex-col items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md text-center"
        >
          <div className="flex flex-col items-center mb-10">
            <div className="w-24 h-24 bg-emerald-500/20 rounded-3xl flex items-center justify-center mb-6 relative">
              <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-full animate-pulse" />
              <Bot className="w-14 h-14 text-emerald-400 relative z-10" />
            </div>
            <h1 className="text-3xl font-black tracking-tight text-white mb-2">OmniGuard🏎</h1>
            <p className="text-slate-400 text-sm font-medium">Initialisation du Dashboard...</p>
          </div>

          <div className="space-y-6">
            {error ? (
              <motion.div 
                initial={{ opacity: 0, y: -10 }} 
                animate={{ opacity: 1, y: 0 }}
                className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-6 rounded-[2rem] flex flex-col gap-4 text-left shadow-2xl"
              >
                <div className="flex items-center gap-3">
                  <XCircle className="w-6 h-6 flex-shrink-0" />
                  <div className="flex flex-col">
                    <span className="font-bold text-sm">Échec de Connexion</span>
                    <span className="opacity-70">{error}</span>
                  </div>
                </div>
                <button 
                  onClick={handleGuestLogin}
                  className="w-full font-black uppercase tracking-widest bg-red-500/20 hover:bg-red-500/30 py-4 rounded-xl transition-all border border-red-500/30"
                >
                  Réessayer Maintenant
                </button>
              </motion.div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
                <p className="text-slate-500 text-xs uppercase tracking-[0.2em] font-bold animate-pulse">Connexion au serveur...</p>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F172A] text-white font-sans pb-10">
      {/* Header */}
      <header className="p-6 flex items-center justify-between sticky top-0 bg-[#0F172A]/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500/20 rounded-xl flex items-center justify-center">
            <Bot className="w-6 h-6 text-emerald-400" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-lg tracking-tight leading-none">OmniGuard<span className="text-emerald-500">🏎</span></span>
            <div className="flex items-center gap-1 mt-1">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-tighter">Watchdog Active</span>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setAuth({ token: null, user: null })}
          className="p-2 bg-slate-800 rounded-xl hover:bg-slate-700 transition-colors"
        >
          <LogOut className="w-5 h-5 text-slate-400" />
        </button>
      </header>

      {/* Tabs */}
      <div className="px-6 mb-6">
        <div className="flex bg-[#1E293B] p-1 rounded-2xl border border-white/5">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold transition-all ${activeTab === 'dashboard' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <LayoutDashboard className="w-4 h-4" /> DASHBOARD
          </button>
          <button 
            onClick={() => setActiveTab('add')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold transition-all ${activeTab === 'add' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <PlusCircle className="w-4 h-4" /> ADD ACCOUNT
          </button>
        </div>
      </div>

      <main className="px-6 space-y-6 max-w-lg mx-auto">
        {isVercel && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-500/10 border border-amber-500/20 p-5 rounded-[2rem] flex items-start gap-4 shadow-2xl"
          >
            <div className="bg-amber-500/20 p-2.5 rounded-2xl shrink-0">
              <Zap className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-amber-400 font-bold text-xs mb-1 uppercase tracking-wider">Hébergement Vercel Détecté</h3>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Vercel ne supporte pas les bots WhatsApp (Serverless). 
                <strong> Votre bot ne restera pas connecté.</strong> Utilisez <a href="https://render.com" target="_blank" className="text-amber-400 underline font-bold">Render.com</a> ou <a href="https://railway.app" target="_blank" className="text-amber-400 underline font-bold">Railway.app</a> pour un bot 24h/24.
              </p>
            </div>
          </motion.div>
        )}

        {isRender && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-blue-500/10 border border-blue-500/20 p-5 rounded-[2rem] flex items-start gap-4 shadow-2xl"
          >
            <div className="bg-blue-500/20 p-2.5 rounded-2xl shrink-0">
              <HardDrive className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="text-blue-400 font-bold text-xs mb-1 uppercase tracking-wider">Persistance Render</h3>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Render efface vos sessions à chaque redémarrage. Pour rester connecté 24h/24, ajoutez un <strong>"Disk"</strong> de 1 Go monté sur <code>/sessions</code> dans votre dashboard Render.
              </p>
            </div>
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' ? (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Active Sessions</h2>
                <span className="text-[10px] font-bold bg-slate-800 px-2 py-1 rounded text-slate-500">{sessions.length} ACCOUNTS</span>
              </div>

              <div className="space-y-4">
                {sessions.length === 0 ? (
                  <div className="text-center py-12 bg-[#1E293B] rounded-3xl border border-dashed border-slate-700">
                    <Bot className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                    <p className="text-slate-400 font-medium">No accounts connected yet.</p>
                    <button 
                      onClick={() => setActiveTab('add')}
                      className="mt-4 text-emerald-400 font-bold text-sm hover:underline"
                    >
                      Connect your first account
                    </button>
                  </div>
                ) : (
                  sessions.map((session) => (
                    <motion.section 
                      key={session.phoneNumber}
                      layout
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="bg-[#1E293B] rounded-3xl p-6 border border-white/5 shadow-xl space-y-6"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${
                            session.status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 
                            session.status === 'connecting' ? 'bg-amber-500 animate-pulse' : 
                            'bg-red-500'
                          }`} />
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{session.status}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-black bg-slate-800 px-2 py-1 rounded text-slate-400">{session.mode.toUpperCase()}</span>
                          <span className="text-[10px] font-black bg-slate-800 px-2 py-1 rounded text-slate-400">PFX: {session.prefix}</span>
                        </div>
                      </div>

                      {session.status === 'connected' ? (
                        <div className="space-y-6">
                          <div className="flex items-center gap-4 p-4 bg-[#0F172A] rounded-2xl border border-slate-700">
                            <div className="w-12 h-12 bg-emerald-500/20 rounded-xl flex items-center justify-center">
                              <Smartphone className="w-6 h-6 text-emerald-400" />
                            </div>
                            <div>
                              <p className="text-xs text-slate-500 font-medium uppercase">Connected Number</p>
                              <p className="text-lg font-bold">+{session.phoneNumber}</p>
                            </div>
                          </div>

                          <div className="p-4 bg-[#0F172A] rounded-2xl border border-slate-700 space-y-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Bot className="w-4 h-4 text-indigo-400" />
                                <span className="text-xs font-bold text-slate-400 uppercase">Status Reaction</span>
                              </div>
                              <button 
                                onClick={() => updateSettings(session.phoneNumber, !session.statusReaction, session.statusReactionEmoji, session.autoReact, session.autoReactEmoji)}
                                className={`w-10 h-5 rounded-full transition-all relative ${session.statusReaction ? 'bg-emerald-500' : 'bg-slate-700'}`}
                              >
                                <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${session.statusReaction ? 'right-1' : 'left-1'}`} />
                              </button>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase">Emoji:</span>
                              <input 
                                type="text"
                                value={session.statusReactionEmoji || '❤️'}
                                onChange={(e) => updateSettings(session.phoneNumber, session.statusReaction, e.target.value, session.autoReact, session.autoReactEmoji)}
                                className="bg-[#1E293B] border border-slate-700 rounded px-2 py-1 text-xs w-12 text-center focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>

                            <div className="h-px bg-slate-700 my-2" />

                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Zap className="w-4 h-4 text-amber-400" />
                                <span className="text-xs font-bold text-slate-400 uppercase">Auto React</span>
                              </div>
                              <button 
                                onClick={() => updateSettings(session.phoneNumber, session.statusReaction, session.statusReactionEmoji, !session.autoReact, session.autoReactEmoji)}
                                className={`w-10 h-5 rounded-full transition-all relative ${session.autoReact ? 'bg-amber-500' : 'bg-slate-700'}`}
                              >
                                <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${session.autoReact ? 'right-1' : 'left-1'}`} />
                              </button>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase">Emoji:</span>
                              <input 
                                type="text"
                                value={session.autoReactEmoji || '🔥'}
                                onChange={(e) => updateSettings(session.phoneNumber, session.statusReaction, session.statusReactionEmoji, session.autoReact, e.target.value)}
                                className="bg-[#1E293B] border border-slate-700 rounded px-2 py-1 text-xs w-12 text-center focus:outline-none focus:ring-1 focus:ring-amber-500"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <button 
                              onClick={() => restartBot(session.phoneNumber)}
                              className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 py-3 rounded-xl font-semibold transition-all text-sm"
                            >
                              <RefreshCw className="w-4 h-4" /> Restart
                            </button>
                            <button 
                              onClick={() => disconnect(session.phoneNumber)}
                              className="flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 py-3 rounded-xl font-semibold transition-all text-sm"
                            >
                              <LogOut className="w-4 h-4" /> Disconnect
                            </button>
                          </div>
                        </div>
                      ) : session.status === 'disconnected' ? (
                        <div className="space-y-6">
                          <div className="flex items-center gap-4 p-4 bg-red-500/5 rounded-2xl border border-red-500/20">
                            <div className="w-12 h-12 bg-red-500/20 rounded-xl flex items-center justify-center">
                              <Smartphone className="w-6 h-6 text-red-400" />
                            </div>
                            <div>
                              <p className="text-xs text-red-500/60 font-medium uppercase">Disconnected</p>
                              <p className="text-lg font-bold text-slate-300">+{session.phoneNumber}</p>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <button 
                              onClick={() => reanimateBot(session.phoneNumber, session.prefix, session.mode)}
                              className="flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 py-3 rounded-xl font-bold transition-all text-sm shadow-lg shadow-emerald-500/20"
                            >
                              <RefreshCw className="w-4 h-4" /> Re-animate
                            </button>
                            <button 
                              onClick={() => disconnect(session.phoneNumber)}
                              className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 py-3 rounded-xl font-semibold transition-all text-sm"
                            >
                              <LogOut className="w-4 h-4" /> Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          <div className="flex items-center gap-4 p-4 bg-[#0F172A] rounded-2xl border border-slate-700">
                            <div className="w-12 h-12 bg-amber-500/20 rounded-xl flex items-center justify-center">
                              <Smartphone className="w-6 h-6 text-amber-400" />
                            </div>
                            <div>
                              <p className="text-xs text-slate-500 font-medium uppercase">Target Number</p>
                              <p className="text-lg font-bold">+{session.phoneNumber}</p>
                            </div>
                          </div>

                          {session.pairingCode && (
                            <motion.div 
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-center relative group"
                            >
                              <button 
                                onClick={() => copyToClipboard(session.pairingCode)}
                                className="absolute top-3 right-3 p-2 bg-emerald-500/20 hover:bg-emerald-500/30 rounded-lg transition-all text-emerald-400"
                                title="Copy Code"
                              >
                                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              </button>
                              <p className="text-xs text-emerald-400 font-bold uppercase tracking-widest mb-3">Pairing Code</p>
                              <div 
                                className="flex justify-center gap-1 sm:gap-2 cursor-pointer active:scale-95 transition-transform flex-wrap"
                                onClick={() => copyToClipboard(session.pairingCode)}
                              >
                                {session.pairingCode.split('').map((char: string, i: number) => (
                                  <React.Fragment key={i}>
                                    <div className="w-8 h-10 sm:w-10 sm:h-12 bg-[#0F172A] border border-emerald-500/30 rounded-lg flex items-center justify-center text-xl sm:text-2xl font-black text-emerald-400 shadow-inner">
                                      {char}
                                    </div>
                                    {i === 3 && <div className="flex items-center text-emerald-400/50 font-bold text-xl px-1">-</div>}
                                  </React.Fragment>
                                ))}
                              </div>
                            </motion.div>
                          )}

                          <button 
                            onClick={() => disconnect(session.phoneNumber)}
                            className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 py-3 rounded-xl font-semibold transition-all text-sm"
                          >
                            Cancel Connection
                          </button>
                        </div>
                      )}
                    </motion.section>
                  ))
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="add"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="bg-[#1E293B] rounded-3xl p-6 border border-white/5 shadow-xl space-y-6">
                <div className="text-center space-y-2">
                  <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <PlusCircle className="w-8 h-8 text-emerald-400" />
                  </div>
                  <h2 className="text-xl font-bold">Link New Account</h2>
                  <p className="text-sm text-slate-500">Enter your phone number to generate a pairing code.</p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Prefix</label>
                      <select 
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value)}
                        className="w-full bg-[#0F172A] border border-slate-700 rounded-xl px-4 py-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                      >
                        <option value=".">. (Dot)</option>
                        <option value="!">! (Exclamation)</option>
                        <option value="/">/ (Slash)</option>
                        <option value="#"># (Hash)</option>
                        <option value="*">* (Star)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Bot Mode</label>
                      <div className="flex bg-[#0F172A] border border-slate-700 rounded-xl p-1 h-[60px]">
                        <button 
                          onClick={() => setIsPublic(false)}
                          className={`flex-1 rounded-lg text-xs font-bold transition-all ${!isPublic ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}
                        >
                          PRIVATE
                        </button>
                        <button 
                          onClick={() => setIsPublic(true)}
                          className={`flex-1 rounded-lg text-xs font-bold transition-all ${isPublic ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}
                        >
                          PUBLIC
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Phone Number</label>
                    <div className="relative">
                      <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                      <input 
                        type="tel" 
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        className="w-full bg-[#0F172A] border border-slate-700 rounded-xl pl-12 pr-4 py-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all font-mono"
                        placeholder="e.g. 447123456789"
                      />
                    </div>
                  </div>

                  <button 
                    onClick={async () => {
                      await connectWhatsApp();
                      setActiveTab('dashboard');
                    }}
                    disabled={loading || !phoneNumber}
                    className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>Requesting Code...</span>
                      </>
                    ) : 'Generate Pairing Code'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        
        {/* Info Cards */}
        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="bg-[#1E293B] p-5 rounded-3xl border border-white/5">
            <ShieldCheck className="w-6 h-6 text-emerald-400 mb-3" />
            <h3 className="text-sm font-bold mb-1">Encrypted</h3>
            <p className="text-xs text-slate-500">End-to-end secure session storage.</p>
          </div>
          <div className="bg-[#1E293B] p-5 rounded-3xl border border-white/5">
            <Bot className="w-6 h-6 text-indigo-400 mb-3" />
            <h3 className="text-sm font-bold mb-1">Auto-Bot</h3>
            <p className="text-xs text-slate-500">Bot starts automatically on connect.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
