import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
}

export default function Card({ children, className = '', title, actions }: CardProps) {
  return (
    <div className={`bg-[#211e1a] border border-[#362f28] rounded-xl overflow-hidden animate-fade-in-up ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#362f28] bg-[#1a1714]">
          {title && <h3 className="text-sm font-semibold text-gray-200">{title}</h3>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

export function Section({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`}>
      {title && <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</h4>}
      {children}
    </div>
  );
}
