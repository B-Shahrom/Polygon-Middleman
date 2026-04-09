import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutList, Settings, ChevronRight, Boxes, User, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useApp } from '../context/AppContext';

export default function Sidebar() {
  const { selectedProblem, username, credentialsSet } = useApp();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="w-14 flex-shrink-0 bg-[#1a1714] border-r border-[#362f28] flex flex-col items-center animate-slide-in-left">
        {/* Expand button */}
        <button
          onClick={() => setCollapsed(false)}
          className="mt-3 mb-2 p-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#2c2722] transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft className="w-4 h-4" />
        </button>

        {/* Logo icon */}
        <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center mb-4">
          <Boxes className="w-4.5 h-4.5 text-white" />
        </div>

        {/* Nav icons */}
        <nav className="flex-1 flex flex-col items-center gap-1 py-1">
          <NavLink
            to="/problems"
            className={({ isActive }) =>
              `p-2.5 rounded-lg transition-colors ${isActive ? 'bg-amber-600/20 text-amber-300' : 'text-gray-500 hover:bg-[#2c2722] hover:text-gray-300'}`
            }
            title="Problems"
          >
            <LayoutList className="w-4 h-4" />
          </NavLink>
        </nav>

        {/* Current problem indicator */}
        {selectedProblem && (
          <button
            onClick={() => navigate(`/problems/${selectedProblem.id}`)}
            className="p-2.5 mb-1 rounded-lg text-gray-500 hover:bg-[#2c2722] hover:text-gray-300 transition-colors"
            title={selectedProblem.name}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}

        {/* Settings icon */}
        <div className="border-t border-[#362f28] w-full flex justify-center py-2">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `p-2.5 rounded-lg transition-colors ${isActive ? 'bg-amber-600/20 text-amber-300' : 'text-gray-500 hover:bg-[#2c2722] hover:text-gray-300'}`
            }
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </NavLink>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-56 flex-shrink-0 bg-[#1a1714] border-r border-[#362f28] flex flex-col animate-slide-in-left">
      {/* Logo + collapse */}
      <div className="px-4 py-5 border-b border-[#362f28]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center flex-shrink-0">
              <Boxes className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <div className="text-sm font-bold text-white leading-none">Polygon</div>
              <div className="text-xs text-amber-400 leading-tight mt-0.5">Middleman</div>
            </div>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-[#2c2722] transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Logged-in user */}
        {credentialsSet && username && (
          <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
            <User className="w-3.5 h-3.5 text-gray-500" />
            <span className="truncate">{username}</span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5">
        <NavLink
          to="/problems"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group ${
              isActive
                ? 'bg-amber-600/20 text-amber-300'
                : 'text-gray-400 hover:bg-[#2c2722] hover:text-gray-200'
            }`
          }
        >
          <LayoutList className="w-4 h-4 flex-shrink-0" />
          Problems
        </NavLink>
      </nav>

      {/* Selected problem */}
      {selectedProblem && (
        <div className="p-2 border-t border-[#362f28]">
          <button
            onClick={() => navigate(`/problems/${selectedProblem.id}`)}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs text-gray-400 hover:bg-[#2c2722] hover:text-gray-200 transition-colors group"
          >
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[11px] text-gray-600 uppercase tracking-wide">Current Problem</div>
              <div className="truncate text-gray-300 font-medium mt-0.5">{selectedProblem.name}</div>
              <div className="text-gray-600 mt-0.5">#{selectedProblem.id} · r{selectedProblem.revision}</div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
      )}

      {/* Settings */}
      <div className="p-2 border-t border-[#362f28]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive
                ? 'bg-amber-600/20 text-amber-300'
                : 'text-gray-500 hover:bg-[#2c2722] hover:text-gray-300'
            }`
          }
        >
          <Settings className="w-4 h-4" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
