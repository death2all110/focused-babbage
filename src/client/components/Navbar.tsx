import React from 'react';
import { Gift, Users, LogOut, LogIn } from 'lucide-react';
import type { User } from '../../shared/types.js';

interface NavbarProps {
  currentUser: User | null;
  onNavigateHome: () => void;
  onNavigateFamily: () => void;
  onOpenAuth: () => void;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentUser,
  onNavigateHome,
  onNavigateFamily,
  onOpenAuth,
  onLogout,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={onNavigateHome}
            className="flex items-center gap-2.5 text-lg font-bold text-slate-50 hover:text-blue-400 transition-colors"
          >
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
              <Gift className="w-5 h-5" />
            </div>
            <span>Family Wishlist</span>
          </button>

          <button
            type="button"
            onClick={onNavigateFamily}
            className="flex items-center gap-1.5 text-sm font-medium text-slate-300 hover:text-slate-50 transition-colors"
          >
            <Users className="w-4 h-4 text-slate-400" />
            <span>Family Lists</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          {currentUser ? (
            <>
              <button
                type="button"
                onClick={onNavigateHome}
                className="text-sm font-medium text-slate-200 hover:text-white px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700"
              >
                {currentUser.display_name}&apos;s Lists
              </button>
              <button
                type="button"
                onClick={onLogout}
                title="Sign out"
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenAuth}
              className="flex items-center gap-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In / Create List</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
