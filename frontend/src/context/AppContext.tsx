import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { Problem } from '../types/polygon';
import { api } from '../api/client';

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

interface AppContextType {
  problems: Problem[];
  setProblems: (p: Problem[]) => void;
  selectedProblem: Problem | null;
  setSelectedProblem: (p: Problem | null) => void;
  toasts: Toast[];
  toast: (type: Toast['type'], message: string) => void;
  dismissToast: (id: number) => void;
  credentialsSet: boolean;
  setCredentialsSet: (v: boolean) => void;
  username: string;
  setUsername: (v: string) => void;
}

const AppContext = createContext<AppContextType | null>(null);

let toastId = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [selectedProblem, setSelectedProblem] = useState<Problem | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [credentialsSet, setCredentialsSet] = useState(false);
  const [username, setUsername] = useState('');

  // Auto-detect credentials from backend config on mount
  useEffect(() => {
    api.credentials.get()
      .then((res) => {
        if (res.api_key && res.has_secret) setCredentialsSet(true);
        if (res.username) setUsername(res.username);
      })
      .catch(() => {});
  }, []);

  const toast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <AppContext.Provider
      value={{
        problems,
        setProblems,
        selectedProblem,
        setSelectedProblem,
        toasts,
        toast,
        dismissToast,
        credentialsSet,
        setCredentialsSet,
        username,
        setUsername,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
