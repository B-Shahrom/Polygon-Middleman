import { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

const variants = {
  primary: 'bg-amber-600 hover:bg-amber-500 text-white border border-amber-500/50 shadow-lg shadow-amber-900/20 active:scale-[0.97]',
  secondary: 'bg-[#2c2722] hover:bg-[#362f28] text-gray-200 border border-[#362f28] hover:border-amber-500/50 active:scale-[0.97]',
  danger: 'bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 hover:border-red-500/60',
  ghost: 'bg-transparent hover:bg-[#2c2722] text-gray-400 hover:text-gray-200 border border-transparent',
  success: 'bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 hover:border-green-500/60',
};

const sizes = {
  xs: 'px-2 py-1 text-xs rounded',
  sm: 'px-3 py-1.5 text-sm rounded-md',
  md: 'px-4 py-2 text-sm rounded-lg',
  lg: 'px-5 py-2.5 text-base rounded-lg',
};

export default function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`
        inline-flex items-center gap-2 font-medium transition-all duration-150
        disabled:opacity-40 disabled:cursor-not-allowed
        ${variants[variant]}
        ${sizes[size]}
        ${className}
      `}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}
