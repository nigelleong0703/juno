---
name: shopping
description: Load first for any product or shopping request - find, compare, price-check, buy, or watch a product for restock or price. Covers saving the user money, planning and asking once, searching shops (with Singapore Shopee/Lazada notes), and checking out.
---
# Shopping

Aim to save the user money: the right product at the lowest price from a shop they can trust.

## Plan, then ask once
- Check what you already know: `memory_search` for the user's shopping profile (sizes, brands, budget, country, address or postcode, the shops they use, past purchases), and the About the user and user's details sections in your context. Use only what applies to this product and wearer.
- Work out what changes the answer and what you can find yourself. Never guess a size, gender, model or what a part must fit; anything else (a scent, a pack size) can be a default you state.
- Think of the blind spots before you start: shops that show real prices only when signed in, bot checks, shipping and vouchers on top of the list price, stock, delivery to the user's postcode, and the purchase approval.
- Then send one `send_message` kind question: a text block with the plan and your defaults in two or three lines ("I'll compare Shopee, Lazada and FairPrice for the 3 kg refill, total with delivery to your postcode"), and one fields block with every question only the user can answer (one field each, select fields for set options), or one choices block when it is a single pick. Put the price in an option when the choice changes it ("256GB - S$3,099"). Asking ends your turn: the answer arrives as the user's next message.
- Keep the answers in every later search, and save what will matter again right away (`profile_update` for the address or postcode, `memory_note` kind preference for brands, sizes, the shops they use). Ask again later only for something new that only the user can decide.

## Search
- Look at the official store and established retailers for the exact variant, in the user's country. `web_search` to find them, `web_fetch` or the `browser.*` tools to open product pages and read price and stock. Drop pages that are not that variant or out of stock.
- For a wide search (many shops, slow pages), `child_spawn` with `notify: true`, tell the user what is running, and carry on talking meanwhile.
- When a page does not show the products or prices: snapshot again after a moment or after scrolling, go to the shop's search URL, read the page with `browser.get_text`, and when it needs a sign-in or a bot check, `request_takeover`. Coordinate clicks on a screenshot are the last resort.
- Bring a short list before any checkout: each product name as a link, price, shop, stock, delivery. Say which is cheapest and why you would pick it.

## Singapore shops (Shopee, Lazada)
- Shopee and Lazada show real prices, vouchers and delivery fees only when signed in. The first time, ask the user once with `request_takeover` to sign in in your browser; the browser keeps the sign-in for later tasks.
- Search URLs: `https://shopee.sg/search?keyword=<words>` and `https://www.lazada.sg/catalog/?q=<words>` (words joined with +).
- Compare the final total for the quantity wanted: item price, shipping, then shop and platform vouchers. Free delivery usually needs a minimum spend; read the current threshold in the cart, it changes with campaigns.
- Note the seller (official or mall store against a reseller) and the delivery date next to each total.

## If nothing can be bought now
Say so plainly, with what each shop showed ("Apple: pre-order opens 20 Oct. Shop B: sold out"). Offer two concrete next steps as a replies block (quick-reply buttons): "Search more retailers" and "Watch for restock". To watch, create a routine with `state_update` or set `wake_at` for the known date, and say what you will check and when.

## Coming back with news
Lead with the news. Then the catch before the user gets excited: contract lock-in, plan cost against the SIM-free price, deadlines, delivery date, return terms. Then the choices.

## Checkout
- Only after the user picked a product and a shop. Re-state item, variant and total first.
- Fill the cart and address with the `browser.*` tools. The platform raises the approval card for the final purchase step; you cannot approve it and you must not try another route around it. Never type card numbers or passwords yourself: use `request_secure_input` for secret fields, and `request_takeover` when the page needs a sign-in or CAPTCHA, then wait.
- Afterwards report what was ordered, the total, and the delivery date. Save a lasting preference the user stated (size, brand, budget) with `memory_note` kind preference.
