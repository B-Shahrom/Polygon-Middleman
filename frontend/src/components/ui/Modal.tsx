import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  footer?: ReactNode;
}

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
};

export default function Modal({ open, onClose, title, children, size = 'md', footer }: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      {/* Panel */}
      <div className={`relative w-full ${sizes[size]} bg-[#211e1a] border border-[#362f28] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] animate-scale-in`}>
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#362f28] bg-[#1a1714] rounded-t-2xl flex-shrink-0">
            <h2 className="text-base font-semibold text-white">{title}</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded-lg hover:bg-[#2c2722]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">{children}</div>
        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#362f28] bg-[#1a1714] rounded-b-2xl flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
