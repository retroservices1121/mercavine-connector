Title: Requesting complete_checkout permission for a Token-tier UCP client (Mercavine Grok Bot connector)

Hi all,

I'm building Mercavine, a free connector that lets AI assistants like Grok Bot shop for people. The connector is a UCP client, and we'd like to know how a client like ours can get permission to call complete_checkout.

Here's how it works today:
- We search the Shopify Catalog, build the checkout with create_checkout and update_checkout, and send the shopper to the merchant's continue_url to pay. We don't call complete_checkout.
- The shopper reviews and approves every order before any payment, and we'll keep that step even if completion is enabled. We wouldn't skip buyer review.
- Our launch categories are home improvement, tools, and electronics.

I've read that direct completion is granted case by case and that there's no public application for it. Is there a way to be considered, and are there eligibility criteria we should be working toward? We're also happy to share our agent profile and walk anyone through our approval flow.

Thanks for any guidance. You can reply here or at mercavine-outreach@mail.grokbot.com.

Joe Perez
CEO, Mercavine
