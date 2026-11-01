import React, { useState } from 'react';
import {
  Share2,
  Plus,
  Download,
  ExternalLink,
  Check,
  Edit2,
  Trash2,
  RotateCcw,
  Gift,
  ShieldAlert,
} from 'lucide-react';
import type { User, WishlistItem, WishlistViewResponse } from '../../shared/types.js';

interface WishlistViewProps {
  data: WishlistViewResponse;
  currentUser: User | null;
  onRefresh: () => void;
  onAddItem?: (defaultSection?: string) => void;
  onEditItem?: (item: WishlistItem) => void;
  onDeleteItem?: (itemId: number) => void;
  onOpenImport?: () => void;
}

const INPUT_CLASS =
  'rounded-lg bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500';

export const WishlistView: React.FC<WishlistViewProps> = ({
  data,
  currentUser,
  onRefresh,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onOpenImport,
}) => {
  const { wishlist, is_owner, items } = data;
  const [activeTab, setActiveTab] = useState<'available' | 'reserved'>('available');
  const [copied, setCopied] = useState(false);
  const [reservingItemId, setReservingItemId] = useState<number | null>(null);
  const [guestName, setGuestName] = useState<string>(() => {
    if (currentUser?.display_name) return currentUser.display_name;
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem('wishlist_guest_name') || ''
        : '';
    } catch {
      return '';
    }
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const availableItems = items.filter((item) => !item.is_reserved);
  const reservedItems = items.filter((item) => item.is_reserved);

  const visibleItems = is_owner
    ? items
    : activeTab === 'available'
      ? availableItems
      : reservedItems;

  const hasSections = visibleItems.some((item) => Boolean(item.section));
  const groupedSections: Array<{ title: string | null; items: WishlistItem[] }> = [];
  if (hasSections) {
    const map = new Map<string, WishlistItem[]>();
    const unsectioned: WishlistItem[] = [];
    for (const item of visibleItems) {
      if (item.section) {
        let bucket = map.get(item.section);
        if (!bucket) {
          bucket = [];
          map.set(item.section, bucket);
        }
        bucket.push(item);
      } else {
        unsectioned.push(item);
      }
    }
    for (const [secTitle, secItems] of map.entries()) {
      groupedSections.push({ title: secTitle, items: secItems });
    }
    if (unsectioned.length > 0) {
      groupedSections.push({ title: 'Other Items', items: unsectioned });
    }
  } else {
    groupedSections.push({ title: null, items: visibleItems });
  }

  const handleCopyShareLink = async () => {
    const shareUrl = `${window.location.origin}/w/${wishlist.slug}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy your wishlist link for Messenger:', shareUrl);
    }
  };

  const handleConfirmReserve = async (itemId: number) => {
    const nameToUse = guestName.trim() || currentUser?.display_name || '';
    if (!nameToUse) {
      setActionError('Please enter your name so the family knows who reserved this gift.');
      return;
    }
    setBusyId(itemId);
    setActionError(null);
    try {
      try {
        localStorage.setItem('wishlist_guest_name', nameToUse);
      } catch {
        // ignore storage errors
      }
      const res = await fetch(`/api/items/${itemId}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reserved_by_name: nameToUse }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionError(body.error || 'Could not reserve item.');
        return;
      }
      setReservingItemId(null);
      onRefresh();
    } catch {
      setActionError('Network error while reserving item.');
    } finally {
      setBusyId(null);
    }
  };

  const handleUnreserve = async (itemId: number) => {
    setBusyId(itemId);
    setActionError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/unreserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionError(body.error || 'Could not unreserve item.');
        return;
      }
      onRefresh();
    } catch {
      setActionError('Network error while unreserving item.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Wishlist Header Card */}
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold text-slate-50">{wishlist.title}</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
              by {wishlist.owner_name}
            </span>
          </div>
          {wishlist.description && (
            <p className="text-sm text-slate-400 mt-1">{wishlist.description}</p>
          )}
          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            {is_owner ? (
              <span>
                Spoiler-Free Creator View: You cannot see which items your family has reserved.
              </span>
            ) : (
              <span>
                No login required to reserve! {wishlist.owner_name} cannot see reservations.
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopyShareLink}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" />
                <span>Link Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="w-4 h-4 text-blue-400" />
                <span>Copy Link for Messenger</span>
              </>
            )}
          </button>

          {is_owner && (
            <>
              <button
                type="button"
                onClick={onOpenImport}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 transition-colors"
              >
                <Download className="w-4 h-4 text-purple-400" />
                <span>Import Things To Get Me</span>
              </button>

              <button
                type="button"
                onClick={() => onAddItem?.()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add Item</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Visitor Tabs: Available vs Reserved (Hidden for Owner!) */}
      {!is_owner && (
        <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
          <button
            type="button"
            onClick={() => setActiveTab('available')}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              activeTab === 'available'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            Available ({availableItems.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('reserved')}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              activeTab === 'reserved'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            Reserved ({reservedItems.length})
          </button>
        </div>
      )}

      {actionError && (
        <div className="rounded-lg bg-red-950/70 border border-red-800 px-4 py-3 text-sm text-red-200">
          {actionError}
        </div>
      )}

      {/* Items List */}
      {visibleItems.length === 0 ? (
        <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-10 text-center">
          <Gift className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-300 font-medium">
            {is_owner
              ? 'Your wishlist is empty. Add an item or import from Things To Get Me!'
              : activeTab === 'available'
                ? 'No available items left on this list!'
                : 'No items have been reserved yet.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedSections.map((group) => (
            <div key={group.title ?? '__all__'} className="space-y-3">
              {group.title && (
                <div className="flex items-center justify-between border-b border-slate-800 pb-2 pt-1">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">
                    {group.title}
                  </h2>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400 font-medium">
                      {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                    </span>
                    {is_owner && group.title !== 'Other Items' && (
                      <button
                        type="button"
                        onClick={() => onAddItem?.(group.title!)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-blue-300 border border-slate-700 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Add here</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:border-slate-700 transition-colors"
                >
              {/* Product Thumbnail */}
              <div className="w-20 h-20 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center overflow-hidden shrink-0">
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={item.name}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <Gift className="w-8 h-8 text-slate-600" />
                )}
              </div>

              {/* Item Details */}
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="text-base font-semibold text-slate-50 break-words">
                    {item.name}
                  </h3>
                  {item.price && (
                    <span className="text-sm font-bold text-emerald-400 bg-emerald-950/50 border border-emerald-800/60 px-2 py-0.5 rounded">
                      {item.price}
                    </span>
                  )}
                </div>

                {/* Variant / Spec Pills */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  {item.color && (
                    <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                      Color: <strong>{item.color}</strong>
                    </span>
                  )}
                  {item.size && (
                    <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                      Size: <strong>{item.size}</strong>
                    </span>
                  )}
                  {item.model && (
                    <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                      {item.model}
                    </span>
                  )}
                  {item.url && /^https?:\/\//i.test(item.url) && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium underline-offset-2 hover:underline"
                    >
                      <span>View at Store</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                {!is_owner && item.is_reserved && (
                  <div className="text-xs font-medium text-emerald-400 pt-0.5">
                    ✓ Reserved by {item.reserved_by_name || 'Family Member'}
                  </div>
                )}
              </div>

              {/* Actions: Creator vs Visitor */}
              <div className="flex items-center gap-2 shrink-0">
                {is_owner ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onEditItem?.(item)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteItem?.(item.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-950/50 hover:bg-red-900/60 text-red-300 border border-red-800/60"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove</span>
                    </button>
                  </>
                ) : !item.is_reserved ? (
                  reservingItemId === item.id ? (
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-950 p-2 rounded-lg border border-slate-700">
                      <input
                        type="text"
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        placeholder="Your name (e.g. Aunt Linda)"
                        className={INPUT_CLASS}
                        autoFocus
                      />
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => handleConfirmReserve(item.id)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setReservingItemId(null)}
                        className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setReservingItemId(item.id)}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                    >
                      Reserve
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => handleUnreserve(item.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Unreserve</span>
                  </button>
                )}
              </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      )}
    </div>
  );
};
