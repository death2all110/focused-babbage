import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Gift, Bookmark, ExternalLink, X } from 'lucide-react';
import type {
  FetchedProductMetadata,
  TtgmImportSummary,
  User,
  Wishlist,
  WishlistItem,
  WishlistViewResponse,
} from '../shared/types.js';
import { Navbar } from './components/Navbar.js';
import { WishlistView } from './components/WishlistView.js';
import { ItemFormModal } from './components/ItemFormModal.js';
import { TtgmImportModal } from './components/TtgmImportModal.js';

const INPUT_CLASS =
  'w-full rounded-lg bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [oauthProviders, setOauthProviders] = useState<{
    google: boolean;
    facebook: boolean;
    amazon: boolean;
  }>({ google: false, facebook: false, amazon: false });
  const [myWishlists, setMyWishlists] = useState<Wishlist[]>([]);
  const [familyWishlists, setFamilyWishlists] = useState<Wishlist[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(() => {
    const m = window.location.pathname.match(/^\/w\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });
  const [viewMode, setViewMode] = useState<'wishlist' | 'family'>(() => {
    if (window.location.pathname.startsWith('/w/')) return 'wishlist';
    if (window.location.pathname === '/family') return 'family';
    return 'wishlist';
  });

  const [activeView, setActiveView] = useState<WishlistViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  // Modals
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<WishlistItem | null>(null);
  const [prefillQuery, setPrefillQuery] = useState<Partial<FetchedProductMetadata> | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showNewListModal, setShowNewListModal] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [newListDesc, setNewListDesc] = useState('');

  const navigateToSlug = useCallback((slug: string) => {
    window.history.pushState({}, '', `/w/${slug}`);
    setActiveSlug(slug);
    setViewMode('wishlist');
  }, []);

  const navigateToFamily = useCallback(() => {
    window.history.pushState({}, '', '/family');
    setActiveSlug(null);
    setViewMode('family');
  }, []);

  const loadWishlist = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`/api/wishlists/${slug}`);
      if (!res.ok) {
        setActiveView(null);
        return;
      }
      const data = (await res.json()) as WishlistViewResponse;
      setActiveView(data);
    } catch {
      setActiveView(null);
    }
  }, []);

  const loadInitialState = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, provRes, famRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/auth/providers'),
        fetch('/api/family'),
      ]);
      const meData = (await meRes.json()) as { user: User | null };
      const provData = (await provRes.json()) as {
        providers: { google: boolean; facebook: boolean; amazon: boolean };
      };
      const famData = (await famRes.json()) as { wishlists: Wishlist[] };

      setCurrentUser(meData.user);
      if (provData.providers) setOauthProviders(provData.providers);
      setFamilyWishlists(famData.wishlists || []);

      let userLists: Wishlist[] = [];
      if (meData.user) {
        const myRes = await fetch('/api/wishlists');
        if (myRes.ok) {
          const myData = (await myRes.json()) as { wishlists: Wishlist[] };
          userLists = myData.wishlists || [];
          setMyWishlists(userLists);
        }
      } else {
        setMyWishlists([]);
      }

      // Check bookmarklet query params (?addUrl=...)
      const params = new URLSearchParams(window.location.search);
      const addUrl = params.get('addUrl');
      if (addUrl && meData.user) {
        setPrefillQuery({
          url: addUrl,
          name: params.get('title') || '',
          price: params.get('price') || null,
          image_url: params.get('image') || null,
        });
        setShowItemModal(true);
        window.history.replaceState({}, '', window.location.pathname);
      }

      const pathMatch = window.location.pathname.match(/^\/w\/([^/]+)/);
      if (pathMatch) {
        const slug = decodeURIComponent(pathMatch[1]);
        setActiveSlug(slug);
        setViewMode('wishlist');
        await loadWishlist(slug);
      } else if (window.location.pathname === '/family') {
        setViewMode('family');
      } else if (userLists.length > 0) {
        setActiveSlug(userLists[0].slug);
        setViewMode('wishlist');
        await loadWishlist(userLists[0].slug);
      } else {
        setViewMode('family');
      }
    } finally {
      setLoading(false);
    }
  }, [loadWishlist]);

  useEffect(() => {
    void loadInitialState();
    const onPopState = () => {
      void loadInitialState();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [loadInitialState]);

  useEffect(() => {
    if (activeSlug && viewMode === 'wishlist') {
      void loadWishlist(activeSlug);
    }
  }, [activeSlug, viewMode, loadWishlist]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: authEmail,
        password: authPassword,
        display_name: authName,
      }),
    });
    const data = (await res.json()) as { user?: User; error?: string };
    if (!res.ok) {
      setAuthError(data.error || 'Authentication failed.');
      return;
    }
    setShowAuthModal(false);
    setAuthEmail('');
    setAuthPassword('');
    setAuthName('');
    await loadInitialState();
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setCurrentUser(null);
    setMyWishlists([]);
    await loadInitialState();
  };

  const handleDeleteItem = async (itemId: number) => {
    if (!activeSlug) return;
    await fetch(`/api/wishlists/${activeSlug}/items/${itemId}`, { method: 'DELETE' });
    await loadWishlist(activeSlug);
  };

  const handleCreateWishlist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListTitle.trim()) return;
    const res = await fetch('/api/wishlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newListTitle.trim(), description: newListDesc.trim() }),
    });
    if (res.ok) {
      const data = (await res.json()) as { wishlist: Wishlist };
      setShowNewListModal(false);
      setNewListTitle('');
      setNewListDesc('');
      await loadInitialState();
      navigateToSlug(data.wishlist.slug);
    }
  };

  const handleImported = async (summary: TtgmImportSummary) => {
    setToast(
      `Imported ${summary.imported_count} items from Things To Get Me (${summary.skipped_received_count} past received skipped, ${summary.enriched_count} auto-enriched with photos/details)!`
    );
    if (activeSlug) {
      await loadWishlist(activeSlug);
    }
  };

  const bookmarkletHref = `javascript:(function(){var t=document.title;var p='';var pEl=document.querySelector('.a-price .a-offscreen,[data-test="product-price"]');if(pEl)p=pEl.textContent.trim();var img='';var iEl=document.querySelector('#landingImage,meta[property="og:image"]');if(iEl)img=iEl.src||iEl.content||'';window.open('${window.location.origin}/?addUrl='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(t)+'&price='+encodeURIComponent(p)+'&image='+encodeURIComponent(img),'_blank');})();`;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <Navbar
        currentUser={currentUser}
        onNavigateHome={() => {
          if (myWishlists.length > 0) {
            navigateToSlug(myWishlists[0].slug);
          } else {
            navigateToFamily();
          }
        }}
        onNavigateFamily={navigateToFamily}
        onOpenAuth={() => setShowAuthModal(true)}
        onLogout={handleLogout}
      />

      <main className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 flex-1 space-y-6">
        {toast && (
          <div className="rounded-xl bg-emerald-950/80 border border-emerald-700 px-4 py-3 text-sm text-emerald-100 flex items-center justify-between">
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-emerald-300 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Signed-in Owner Bar: Switch between lists & Bookmarklet helper */}
        {currentUser && myWishlists.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-1">
                My Lists:
              </span>
              {myWishlists.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => navigateToSlug(w.slug)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    activeSlug === w.slug && viewMode === 'wishlist'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {w.title}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowNewListModal(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-700"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New List</span>
              </button>
            </div>

            <a
              href={bookmarkletHref}
              onClick={(e) => {
                e.preventDefault();
                alert(
                  'Drag this "+ Add to Wishlist" button to your browser Bookmarks Bar! When shopping on Amazon, Target, Walmart, etc., click it to send the item straight to your wishlist.'
                );
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700"
              title="Drag to your bookmarks bar"
            >
              <Bookmark className="w-3.5 h-3.5 text-amber-400" />
              <span>+ Add to Wishlist Bookmarklet</span>
            </a>
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">Loading wishlist...</div>
        ) : viewMode === 'wishlist' && activeView ? (
          <WishlistView
            data={activeView}
            currentUser={currentUser}
            onRefresh={() => {
              if (activeSlug) void loadWishlist(activeSlug);
            }}
            onAddItem={() => {
              setEditingItem(null);
              setPrefillQuery(null);
              setShowItemModal(true);
            }}
            onEditItem={(item) => {
              setEditingItem(item);
              setPrefillQuery(null);
              setShowItemModal(true);
            }}
            onDeleteItem={handleDeleteItem}
            onOpenImport={() => setShowImportModal(true)}
          />
        ) : (
          /* Family Directory View */
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div>
                <h1 className="text-2xl font-bold text-slate-50">Family Wishlists</h1>
                <p className="text-sm text-slate-400 mt-1">
                  Click any family member&apos;s list below to view and reserve gifts—no login
                  required!
                </p>
              </div>
              {!currentUser && (
                <button
                  type="button"
                  onClick={() => setShowAuthModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>Sign In to Create Your List</span>
                </button>
              )}
            </div>

            {familyWishlists.length === 0 ? (
              <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-12 text-center space-y-3">
                <Gift className="w-10 h-10 text-slate-600 mx-auto" />
                <p className="text-slate-300 font-medium">No wishlists have been created yet.</p>
                {!currentUser && (
                  <button
                    type="button"
                    onClick={() => setShowAuthModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white"
                  >
                    Create the First Wishlist
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {familyWishlists.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => navigateToSlug(w.slug)}
                    className="text-left rounded-xl bg-slate-900 hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 p-5 transition-all flex items-center justify-between group"
                  >
                    <div>
                      <h3 className="text-lg font-semibold text-slate-50 group-hover:text-blue-400 transition-colors">
                        {w.title}
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">Created by {w.owner_name}</p>
                      {w.description && (
                        <p className="text-xs text-slate-300 mt-2 line-clamp-2">{w.description}</p>
                      )}
                    </div>
                    <ExternalLink className="w-5 h-5 text-slate-500 group-hover:text-blue-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Add / Edit Item Modal */}
      {showItemModal && activeSlug && (
        <ItemFormModal
          wishlistSlug={activeSlug}
          initialItem={editingItem}
          prefillFromQuery={prefillQuery}
          onClose={() => {
            setShowItemModal(false);
            setEditingItem(null);
            setPrefillQuery(null);
          }}
          onSaved={() => {
            void loadWishlist(activeSlug);
          }}
        />
      )}

      {/* Things To Get Me Import Modal */}
      {showImportModal && activeSlug && (
        <TtgmImportModal
          wishlistSlug={activeSlug}
          onClose={() => setShowImportModal(false)}
          onImported={handleImported}
        />
      )}

      {/* Create New Wishlist Modal */}
      {showNewListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl bg-slate-900 border border-slate-700 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-50">Create New Wishlist</h2>
              <button
                type="button"
                onClick={() => setShowNewListModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateWishlist} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
                  Wishlist Title *
                </label>
                <input
                  type="text"
                  required
                  value={newListTitle}
                  onChange={(e) => setNewListTitle(e.target.value)}
                  placeholder="e.g. Blake Christmas 2026"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
                  Description / Notes
                </label>
                <input
                  type="text"
                  value={newListDesc}
                  onChange={(e) => setNewListDesc(e.target.value)}
                  placeholder="Optional notes for family"
                  className={INPUT_CLASS}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewListModal(false)}
                  className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white"
                >
                  Create List
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sign In / OAuth Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl bg-slate-900 border border-slate-700 overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
              <h2 className="text-base font-semibold text-slate-50">
                {authMode === 'login' ? 'Sign In to Manage Your List' : 'Create Your Family Account'}
              </h2>
              <button
                type="button"
                onClick={() => setShowAuthModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* OAuth Buttons */}
              {(oauthProviders.google || oauthProviders.facebook || oauthProviders.amazon) && (
                <>
                  <div className="space-y-2">
                    {oauthProviders.google && (
                      <a
                        href="/api/auth/oauth/google"
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold border bg-slate-800 hover:bg-slate-700 text-slate-50 border-slate-600 transition-colors"
                      >
                        <span>Continue with Google</span>
                      </a>
                    )}
                    {oauthProviders.facebook && (
                      <a
                        href="/api/auth/oauth/facebook"
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold border bg-blue-950/80 hover:bg-blue-900/80 text-blue-100 border-blue-700 transition-colors"
                      >
                        <span>Continue with Facebook</span>
                      </a>
                    )}
                    {oauthProviders.amazon && (
                      <a
                        href="/api/auth/oauth/amazon"
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold border bg-amber-950/80 hover:bg-amber-900/80 text-amber-100 border-amber-700 transition-colors"
                      >
                        <span>Login with Amazon</span>
                      </a>
                    )}
                  </div>

                  <div className="relative flex py-1 items-center">
                    <div className="flex-grow border-t border-slate-800" />
                    <span className="flex-shrink mx-3 text-xs uppercase text-slate-400">
                      Or use email
                    </span>
                    <div className="flex-grow border-t border-slate-800" />
                  </div>
                </>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-3">
                {authMode === 'register' && (
                  <div>
                    <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
                      Your Name
                    </label>
                    <input
                      type="text"
                      required
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder="e.g. Blake"
                      className={INPUT_CLASS}
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={INPUT_CLASS}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="••••••••"
                    className={INPUT_CLASS}
                  />
                </div>

                {authError && (
                  <div className="rounded-lg bg-red-950/60 border border-red-800 px-3 py-2 text-xs text-red-200">
                    {authError}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white"
                >
                  {authMode === 'login' ? 'Sign In' : 'Create Account & Wishlist'}
                </button>
              </form>

              <div className="text-center text-xs text-slate-400 pt-1">
                {authMode === 'login' ? (
                  <>
                    Need a wishlist account?{' '}
                    <button
                      type="button"
                      onClick={() => setAuthMode('register')}
                      className="text-blue-400 hover:underline font-medium"
                    >
                      Create one here
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => setAuthMode('login')}
                      className="text-blue-400 hover:underline font-medium"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
