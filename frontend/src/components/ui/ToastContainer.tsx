import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';

const icons = {
  success: <CheckCircle2 className="w-4 h-4 text-green-400" />,
  error: <XCircle className="w-4 h-4 text-red-400" />,
  info: <Info className="w-4 h-4 text-blue-400" />,
  warning: <AlertTriangle className="w-4 h-4 text-yellow-400" />,
};

const colors = {
  success: 'border-green-500/30 bg-green-500/10',
  error: 'border-red-500/30 bg-red-500/10',
  info: 'border-blue-500/30 bg-blue-500/10',
  warning: 'border-yellow-500/30 bg-yellow-500/10',
};

export default function ToastContainer() {
  const { toasts, dismissToast } = useApp();

  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 p-3.5 rounded-xl border backdrop-blur-sm shadow-2xl animate-fade-in-up ${colors[t.type]}`}
        >
          <span className="flex-shrink-0 mt-0.5">{icons[t.type]}</span>
          <span className="flex-1 text-sm text-gray-200 leading-snug">{t.message}</span>
          <button
            onClick={() => dismissToast(t.id)}
            className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
