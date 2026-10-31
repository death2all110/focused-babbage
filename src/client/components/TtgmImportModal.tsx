import React, { useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import type { TtgmImportSummary } from '../../shared/types.js';

interface TtgmImportModalProps {
  wishlistSlug: string;
  onClose: () => void;
  onImported: (summary: TtgmImportSummary) => void;
}

const INPUT_CLASS =
  'w-full rounded-lg bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export const TtgmImportModal: React.FC<TtgmImportModalProps> = ({
  wishlistSlug,
  onClose,
  onImported,
}) => {
  const [urlOrCode, setUrlOrCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlOrCode.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/wishlists/${wishlistSlug}/import-ttgm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlOrCode: urlOrCode.trim() }),
      });
      const data = (await res.json()) as TtgmImportSummary & { error?: string };
      if (!res.ok) {
        setError(data.error || 'Could not import Things To Get Me list.');
        return;
      }
      onImported(data);
      onClose();
    } catch {
      setError('Network error while importing list.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-lg rounded-xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
          <h2 className="text-base font-semibold text-slate-50">
            Import from Things To Get Me
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
          <p className="text-sm text-slate-300 leading-relaxed">
            Paste your <code className="text-blue-400">thingstogetme.com</code> share link or list
            code. Past received items will be skipped automatically, active reservations will be
            migrated spoiler-free in the background, and missing product photos will be fetched!
          </p>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Things To Get Me Link or Code
            </label>
            <input
              type="text"
              required
              value={urlOrCode}
              onChange={(e) => setUrlOrCode(e.target.value)}
              placeholder="https://www.thingstogetme.com/902589a87070"
              className={INPUT_CLASS}
            />
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
              disabled={loading || !urlOrCode.trim()}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Importing &amp; Enriching...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Import List</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
