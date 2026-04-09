import { InputHTMLAttributes, TextareaHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  mono?: boolean;
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

const inputBase = `
  w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2
  text-gray-200 placeholder-gray-500 text-sm
  focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50
  transition-colors duration-150
`;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, className = '', ...props }, ref) => (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</label>}
      <input ref={ref} {...props} className={`${inputBase} ${error ? 'border-red-500' : ''} ${className}`} />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {helperText && !error && <p className="text-xs text-gray-500">{helperText}</p>}
    </div>
  )
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, mono, className = '', rows = 6, ...props }, ref) => (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</label>}
      <textarea
        ref={ref}
        rows={rows}
        {...props}
        className={`
          ${inputBase} resize-y
          ${mono ? 'font-mono text-xs leading-relaxed' : ''}
          ${error ? 'border-red-500' : ''}
          ${className}
        `}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {helperText && !error && <p className="text-xs text-gray-500">{helperText}</p>}
    </div>
  )
);
Textarea.displayName = 'Textarea';

export function Select({ label, error, options, className = '', ...props }: SelectProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</label>}
      <select
        {...props}
        className={`${inputBase} cursor-pointer ${error ? 'border-red-500' : ''} ${className}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#211e1a]">
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
