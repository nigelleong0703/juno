/**
 * The approval card of a purchase, built here from the structured `purchase` args and the screenshot, never
 * authored by the model (BACKEND 8.7.1): the page data is untrusted, so it is clipped into fixed blocks and the
 * consequence line is ours.
 */
import { withFallbackText, type ApprovalPayload, type ApprovalPurchase, type UiDoc } from '@agent-desktop/public-contracts';

const clip = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

export function purchaseApprovalDoc(purchase: ApprovalPurchase, preview?: ApprovalPayload['preview']): UiDoc {
  const total = purchase.total === undefined ? undefined : clip(purchase.total, 40);
  const items = purchase.items.map((item) => ({
    name: clip(item.name, 120) || 'Item',
    ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
    ...(item.price === undefined || clip(item.price, 40) === '' ? {} : { price: clip(item.price, 40) }),
  }));
  const facts = [
    ...(items.length === 0 && total !== undefined ? [{ label: 'Total', value: total, emphasis: true }] : []),
    ...(purchase.delivery === undefined ? [] : [{ label: 'Delivery', value: clip(purchase.delivery, 120) }]),
    ...(purchase.paymentMethod === undefined ? [] : [{ label: 'Payment', value: clip(purchase.paymentMethod, 120) }]),
  ].filter((row) => row.value !== '');
  const consequence = total === undefined ? 'Approving lets the agent place this order.' : `Approving lets the agent place this order and pay ${total}.`;
  return withFallbackText({
    version: 1,
    title: `Place this order at ${clip(purchase.merchant, 40)}?`,
    blocks: [
      ...(items.length === 0 ? [] : [{ type: 'items' as const, rows: items, ...(total === undefined ? {} : { total: { label: 'Total', value: total } }) }]),
      ...(facts.length === 0 ? [] : [{ type: 'facts' as const, rows: facts }]),
      { type: 'notice' as const, tone: 'warning' as const, text: consequence },
      ...(preview === undefined ? [] : [{ type: 'image' as const, libraryId: preview.libraryId, caption: 'The page as it is now' }]),
    ],
  });
}
