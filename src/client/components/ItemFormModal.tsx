import React, { useState } from 'react';
import { X, Sparkles, Loader2, ExternalLink } from 'lucide-react';
import type { FetchedProductMetadata, WishlistItem } from '../../shared/types.js';

interface ItemFormModalProps {
  wishlistSlug: string;
  initialItem?: WishlistItem | null;
  prefillFromQuery?: Partial<FetchedProductMetadata> | null;
  existingSections?: string[];
  defaultSection?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const INPUT_CLASS =
  'w-full rounded-lg bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export const ItemFormModal: React.FC<ItemFormModalProps> = ({
  wishlistSlug,
  initialItem,
  prefillFromQuery,
  existingSections = [],
  defaultSection = null,
  onClose,
  onSaved,
}) => {
  const initialSec = initialItem?.section ?? defaultSection ?? '';
  const isInitialCustom = Boolean(initialSec && !existingSections.includes(initialSec));

  const [url, setUrl] = useState(initialItem?.url ?? prefillFromQuery?.url ?? '');
  const [name, setName] = useState(initialItem?.name ?? prefillFromQuery?.name ?? '');
  const [selectedSection, setSelectedSection] = useState<string>(
    isInitialCustom ? '__new__' : initialSec
  );
  const [newSectionName, setNewSectionName] = useState<string>(isInitialCustom ? initialSec : '');
  const [price, setPrice] = useState(initialItem?.price ?? prefillFromQuery?.price ?? '');
  const [imageUrl, setImageUrl] = useState(
    initialItem?.image_url ?? prefillFromQuery?.image_url ?? ''
  );
  const [color, setColor] = useState(initialItem?.color ?? prefillFromQuery?.color ?? '');
  const [size, setSize] = useState(initialItem?.size ?? prefillFromQuery?.size ?? '');
  const [model, setModel] = useState(initialItem?.model ?? prefillFromQuery?.model ?? '');

  const [fetching, setFetching] = useState(false);
  const [fetchNotice, setFetchNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetchUrl = async (targetUrl?: string) => {
    const toFetch = (targetUrl ?? url).trim();
    if (!toFetch) return;
    setFetching(true);
    setFetchNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: toFetch }),
      });
      const data = (await res.json()) as FetchedProductMetadata & { error?: string };
      if (!res.ok) {
        setError(data.error || 'Could not fetch product details automatically.');
        return;
      }

      if (data.name) setName(data.name);
      if (data.price) setPrice(data.price);
      if (data.image_url) setImageUrl(data.image_url);
      if (data.color) setColor(data.color);
      if (data.size) setSize(data.size);
      if (data.model) setModel(data.model);

      if (data.partial) {
        setFetchNotice(
          `Pulled available info from ${data.store_name || 'store'}. Please review or fill in any missing fields below.`
        );
      } else {
        setFetchNotice(`Fetched details from ${data.store_name || 'store'}!`);
      }
    } catch {
      setError('Could not reach server to fetch URL. You can fill in the details manually below.');
    } finally {
      setFetching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Item name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const endpoint = initialItem
        ? `/api/wishlists/${wishlistSlug}/items/${initialItem.id}`
        : `/api/wishlists/${wishlistSlug}/items`;
      const method = initialItem ? 'PATCH' : 'POST';

      const finalSection =
        selectedSection === '__new__' ? newSectionName.trim() : selectedSection.trim();

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          section: finalSection || null,
          url: url.trim() || null,
          price: price.trim() || null,
          image_url: imageUrl.trim() || null,
          color: color.trim() || null,
          size: size.trim() || null,
          model: model.trim() || null,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || 'Failed to save item.');
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError('Network error while saving item.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
          <h2 className="text-base font-semibold text-slate-50">
            {initialItem ? 'Edit Wishlist Item' : 'Add Item to Wishlist'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Product Link (Amazon, Target, Walmart, Best Buy, Kohl&apos;s, etc.)
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text');
                  if (pasted && /^https?:\/\//i.test(pasted.trim()) && !name) {
                    setTimeout(() => handleFetchUrl(pasted.trim()), 50);
                  }
                }}
                placeholder="Paste product link to auto-fill details..."
                className={INPUT_CLASS}
              />
              <button
                type="button"
                disabled={fetching || !url.trim()}
                onClick={() => handleFetchUrl()}
                className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
              >
                {fetching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span>{fetching ? 'Fetching...' : 'Fetch'}</span>
              </button>
            </div>
            {fetchNotice && <p className="mt-1.5 text-xs text-emerald-400">{fetchNotice}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Item Name *
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. KitchenAid 5-Qt Stand Mixer"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Price
              </label>
              <input
                type="text"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="$49.99"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="item-section-select"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1"
            >
              Section / Category
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                id="item-section-select"
                value={selectedSection}
                onChange={(e) => setSelectedSection(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">No Section (General)</option>
                {existingSections.map((sec) => (
                  <option key={sec} value={sec}>
                    {sec}
                  </option>
                ))}
                <option value="__new__">+ Create New Section...</option>
              </select>

              {selectedSection === '__new__' && (
                <input
                  type="text"
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                  placeholder="Enter new section name..."
                  className={INPUT_CLASS}
                  autoFocus
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Color
              </label>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="e.g. Navy / Pistachio"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Size
              </label>
              <input
                type="text"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="e.g. Medium / 10.5"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Model / Notes
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model # or notes"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Photo URL
            </label>
            <div className="flex gap-3 items-center">
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://..."
                className={INPUT_CLASS}
              />
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt="Preview"
                  className="w-12 h-12 rounded-lg object-cover border border-slate-700 bg-slate-950 shrink-0"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-950/60 border border-red-800 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white"
            >
              {saving ? 'Saving...' : initialItem ? 'Save Changes' : 'Add to Wishlist'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
