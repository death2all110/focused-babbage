// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WishlistView } from '../src/client/components/WishlistView';
import { ItemFormModal } from '../src/client/components/ItemFormModal';
import { WishlistViewResponse } from '../src/shared/types';

const sampleVisitorData: WishlistViewResponse = {
  wishlist: {
    id: 1,
    user_id: 10,
    owner_name: 'Sarah',
    slug: 'sarah-holiday',
    title: "Sarah's Holiday Wishlist",
    description: 'Sizes and links inside!',
    is_public: true,
    created_at: '2026-10-31',
    updated_at: '2026-10-31',
  },
  is_owner: false,
  items: [
    {
      id: 101,
      wishlist_id: 1,
      name: 'Merino Wool Sweater',
      section: 'Clothes',
      url: 'https://www.kohls.com/sweater',
      price: '$59.50',
      image_url: null,
      color: 'Navy',
      size: 'Medium',
      model: null,
      priority: 0,
      is_reserved: false,
      reserved_by_name: null,
      reserved_at: null,
      created_at: '2026-10-31',
      updated_at: '2026-10-31',
    },
    {
      id: 102,
      wishlist_id: 1,
      name: 'KitchenAid Stand Mixer',
      section: 'Kitchen',
      url: 'https://www.target.com/mixer',
      price: '$349.99',
      image_url: null,
      color: 'Pistachio',
      size: '5 Quart',
      model: 'KSM150PS',
      priority: 0,
      is_reserved: true,
      reserved_by_name: 'Uncle Bob',
      reserved_at: '2026-10-31',
      created_at: '2026-10-31',
      updated_at: '2026-10-31',
    },
  ],
};

describe('Wishlist Frontend Views', () => {
  it('renders Available and Reserved tabs for visitors, hiding reserved items from Available tab to reduce clutter', () => {
    render(<WishlistView data={sampleVisitorData} currentUser={null} onRefresh={vi.fn()} />);

    // Available tab is active by default and shows only unreserved item
    expect(screen.getByText(/Available \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Reserved \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('Merino Wool Sweater')).toBeInTheDocument();
    expect(screen.queryByText('KitchenAid Stand Mixer')).not.toBeInTheDocument();

    // Clicking Reserved tab shows the reserved item and who reserved it
    fireEvent.click(screen.getByText(/Reserved \(1\)/i));
    expect(screen.getByText('KitchenAid Stand Mixer')).toBeInTheDocument();
    expect(screen.getByText(/Reserved by Uncle Bob/i)).toBeInTheDocument();
  });

  it('hides Available/Reserved tabs completely when is_owner is true (Creator View)', () => {
    const ownerData: WishlistViewResponse = {
      ...sampleVisitorData,
      is_owner: true,
      items: sampleVisitorData.items.map((i) => ({
        ...i,
        is_reserved: false,
        reserved_by_name: null,
      })),
    };
    render(
      <WishlistView
        data={ownerData}
        currentUser={{
          id: 10,
          email: 's@e.com',
          display_name: 'Sarah',
          avatar_url: null,
          created_at: '',
        }}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.queryByText(/Reserved \(/i)).not.toBeInTheDocument();
    expect(screen.getByText('Merino Wool Sweater')).toBeInTheDocument();
    expect(screen.getByText('KitchenAid Stand Mixer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Clothes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kitchen' })).toBeInTheDocument();
  });

  it('uses dark background and light text classes on form inputs in ItemFormModal', () => {
    render(<ItemFormModal wishlistSlug="sarah-holiday" onClose={vi.fn()} onSaved={vi.fn()} />);
    const urlInput = screen.getByPlaceholderText(/Paste product link/i);
    expect(urlInput.className).toContain('bg-slate-900');
    expect(urlInput.className).toContain('text-slate-50');
    expect(urlInput.className).not.toContain('bg-white');
  });

  it('allows selecting an existing section or creating a new section in ItemFormModal', () => {
    render(
      <ItemFormModal
        wishlistSlug="sarah-holiday"
        existingSections={['Bedroom Decor', 'Books']}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    const sectionSelect = screen.getByLabelText(/Section/i) as HTMLSelectElement;
    expect(sectionSelect).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bedroom Decor' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Books' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\+ Create New Section/i })).toBeInTheDocument();

    // Selecting "+ Create New Section..." reveals the custom section input
    fireEvent.change(sectionSelect, { target: { value: '__new__' } });
    const newSectionInput = screen.getByPlaceholderText(/Enter new section name/i);
    expect(newSectionInput).toBeInTheDocument();
    expect(newSectionInput.className).toContain('bg-slate-900');
    expect(newSectionInput.className).toContain('text-slate-50');
  });
});
