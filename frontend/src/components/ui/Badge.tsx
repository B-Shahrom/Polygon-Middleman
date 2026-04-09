import { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'danger' | 'warning' | 'info' | 'indigo';
  className?: string;
}

const variants = {
  default: 'bg-[#2c2722] text-gray-300 border-[#362f28]',
  success: 'bg-green-500/15 text-green-400 border-green-500/30',
  danger: 'bg-red-500/15 text-red-400 border-red-500/30',
  warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  indigo: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

export default function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${variants[variant]} ${className}`}>
      {children}
    </span>
  );
}

export function SolutionTagBadge({ tag }: { tag: string }) {
  const cls = `tag-${tag}`;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${cls}`}>
      {tag}
    </span>
  );
}

export function PackageStateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    PENDING: 'warning',
    RUNNING: 'info',
    READY: 'success',
    FAILED: 'danger',
  };
  return <Badge variant={(map[state] || 'default') as BadgeProps['variant']}>{state}</Badge>;
}
