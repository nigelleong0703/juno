import { describe, expect, it } from 'vitest';
import { isFinalPurchaseLabel, isRiskyLabel } from '../computer/purchase.js';

describe('purchase reviewer: which controls it looks at', () => {
  const product = { url: 'https://www.apple.com/sg/mac-mini/', payment: false };
  const checkout = { url: 'https://www.apple.com/sg/shop/checkout', payment: false };
  const cardPage = { url: 'https://shop.example/review', payment: true };

  it('lets a "Buy" link on a product page through: a link only navigates', () => {
    expect(isRiskyLabel('Buy, Mac mini', 'link', product)).toBe(false);
    expect(isRiskyLabel('Book a table', 'link', product)).toBe(false);
  });

  it('still reviews the same words on a button, and any link on a checkout or payment page', () => {
    expect(isRiskyLabel('Buy, Mac mini', 'button', product)).toBe(true);
    expect(isRiskyLabel('Buy now', 'link', checkout)).toBe(true);
    expect(isRiskyLabel('Complete purchase', 'link', cardPage)).toBe(true);
  });

  it('keeps hard-gating final purchase labels whatever their role', () => {
    expect(isFinalPurchaseLabel('Place order')).toBe(true);
    expect(isFinalPurchaseLabel('Pay now')).toBe(true);
  });
});
