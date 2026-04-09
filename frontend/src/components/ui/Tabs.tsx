import { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: number | string;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export default function Tabs({ tabs, active, onChange, className = '' }: TabsProps) {
  return (
    <div className={`flex border-b border-[#362f28] overflow-x-auto ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`
            relative flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap
            transition-colors duration-150 border-b-2 -mb-px
            ${active === tab.id
              ? 'text-amber-400 border-amber-500'
              : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-600'
            }
          `}
        >
          {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
          {tab.label}
          {tab.badge !== undefined && (
            <span className={`
              text-xs px-1.5 py-0.5 rounded-full font-mono
              ${active === tab.id ? 'bg-amber-500/20 text-amber-300' : 'bg-[#2c2722] text-gray-500'}
            `}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
