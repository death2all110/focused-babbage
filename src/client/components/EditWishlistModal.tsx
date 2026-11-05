import React, { useState } from 'react';
import { X, Edit2, Loader2 } from 'lucide-react';
import type { Wishlist } from '../../shared/types.js';

interface EditWishlistModalProps {
  wishlist: Wishlist;
  onClose: () => void;
  onSaved: (title: string, description: string) => Promise<void>;
}

const INPUT_CLASS =
  'w-full rounded-lg bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 px-3.5 py-2 text-sm focus:outline-none focus:border-blue-500 transition-colors';

export const EditWishlistModal: React.FC<EditWishlistModalProps> = ({
  wishlist,
  onClose,
  onSaved,
}) => {
  const [title, setTitle] = useState(wishlist.title);
  const [description, setDescription] = useState(wishlist.description || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Wishlist name cannot be empty.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSaved(cleanTitle, description.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update wishlist.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <Edit2 className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-slate-100">Edit Wishlist</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-950/50 border border-red-800 text-red-200 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
              Wishlist Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sarah's Birthday 2026"
              className={INPUT_CLASS}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
              Description <span className="text-slate-500 font-normal">(Optional)</span>
            </label>
            <textarea
              rows={3}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add clothing sizes, favorite colors, or notes for family..."
              className={INPUT_CLASS}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
