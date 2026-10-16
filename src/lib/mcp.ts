import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { botByToken, type BotRecord } from "./auth";
import { cancelCart, createCart, getCartForBot, submitCart, updateCart, type LineInput } from "./cart";
import { config } from "./config";
import { ApiError, errorBody } from "./errors";
import { cancelOrder, getOrder, listOrders, requestReturn } from "./orders";
import { lookupProduct, searchAcross } from "./search";
import { shopLinkPublic, startShopLink, stripClientShopLine, verifyShopLines } from "./shop-pay";

function header(extra: RequestHandlerExtra<ServerRequest, ServerNotification>, name: string): string {
  const headers = extra.requestInfo?.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function botFromExtra(extra: RequestHandlerExtra<ServerRequest, ServerNotification>, scope: string): BotRecord {
  const token = (extra.authInfo?.token || header(extra, "authorization").replace(/^Bearer\s+/i, "")).trim();
  if (!token) throw new ApiError(401, "unauthorized", "Send Authorization: Bearer <bot token>.");
  const bot = botByToken(token);
  if (!bot) throw new ApiError(401, "unauthorized", "Unknown bot token.");
  if (bot.revoked_at) throw new ApiError(401, "bot_revoked", "This bot was revoked.");
  if (!bot.scopes.includes(scope)) throw new ApiError(403, "scope_missing", `Missing scope ${scope}.`, { scope });
  return bot;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  const body = error instanceof ApiError ? errorBody(error) : { error: { code: "internal", message: "Tool failed." } };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

async function tool<T>(fn: () => Promise<T> | T) {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

export function createMcpServer() {
  const cfg = config();
  const server = new McpServer(
    { name: cfg.brandHandle, version: "0.1.0" },
    {
      instructions: [
        `${cfg.brandName} is a free shopping connector. Search the catalog, build a server-side cart, and call request_checkout.`,
        "request_checkout returns a single-use approval URL. Show that URL to the human. You never collect or complete payment.",
        "Poll get_cart or get_order_status afterward. Shopify items, when enabled, hand off to the merchant continue_url. Pass that url through unchanged, including shclid and shcgid. If an offer label is Sponsored, tell the shopper it is Sponsored before they open it. Do not quote a commission rate.",
        "Shop catalog results use source shop. Do not cache them and do not download merchant images; show the source URL.",
        "Shop Pay, when enabled, still needs the human's Mercavine approval and a separate Shop Pay approval. Show shop_pay.continue_url. The 3% fee does not apply to Shop Pay orders.",
        `The platform fee is ${cfg.platformFeeBps / 100}% of each Mercavine seller charge and is paid by the seller, not added to the shopper total.`,
        "Mutating tools require idempotency_key.",
      ].join(" "),
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Search Mercavine sellers. Launch categories: home-improvement, tools, electronics-accessories. Outdoor is secondary. Lane shopify queries Shopify Catalog when SHOPIFY_CATALOG_ENABLED=true. Lane shop queries Shop's global catalog. Each result is labeled source native, shopify, or shop. Shop results are not cached.",
      inputSchema: {
        query: z.string().describe("What the shopper wants, for example brass door hinges"),
        category: z.string().optional(),
        max_price: z.number().int().optional().describe("Maximum unit price in cents"),
        in_stock: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
        lane: z.enum(["native", "shopify", "shop", "all"]).optional(),
      },
    },
    async (args, extra) =>
      tool(async () => {
        botFromExtra(extra, "search");
        const lane = args.lane ?? "native";
        const found = await searchAcross(lane, { q: args.query, category: args.category, maxPrice: args.max_price, inStock: args.in_stock, limit: args.limit });
        return { lane, results: found.results, shopify: found.shopify, shop: found.shop };
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get a product",
      description: "Fetch one product. Ids that start with shop: come from Shop. Shopify ids require the catalog flag. Missing or unavailable Shop fields are not linkable.",
      inputSchema: {
        product_id: z.string(),
        source: z.enum(["native", "shopify", "shop"]).optional(),
      },
    },
    async (args, extra) =>
      tool(async () => {
        botFromExtra(extra, "search");
        const product = await lookupProduct(args.product_id, args.source);
        if (!product) throw new ApiError(404, "not_found", "Product not found.");
        return product;
      }),
  );

  server.registerTool(
    "create_cart",
    {
      title: "Create a cart",
      description: "Create a server-side draft cart. Prices are quotes until request_checkout. Requires idempotency_key. Do not send payment details.",
      inputSchema: {
        lines: z.array(z.object({
          offer_id: z.string().optional(),
          quantity: z.number().int().min(1).max(99),
          provider: z.enum(["native", "shopify", "shop"]).optional(),
          external_id: z.string().optional(),
          title: z.string().optional(),
          seller_name: z.string().optional(),
          seller_id: z.string().optional(),
          unit_price: z.number().int().optional(),
          continue_url: z.string().optional(),
          placement: z.object({
            type: z.string(),
            commission: z.object({ percentage: z.object({ value: z.number() }) }).nullable().optional(),
          }).nullable().optional(),
        })).optional(),
        shipping_address_id: z.string().optional(),
        note_for_human: z.string().max(500).optional(),
        client_reference: z.string().max(200).optional(),
        from_cart_id: z.string().optional(),
        idempotency_key: z.string().min(8),
      },
    },
    async (args, extra) =>
      tool(async () => {
        const bot = botFromExtra(extra, "cart");
        const lines = args.lines ? await verifyShopLines(args.lines.map((line) => stripClientShopLine(line as LineInput))) : undefined;
        const result = createCart({
          bot,
          lines,
          shippingAddressId: args.shipping_address_id,
          note: args.note_for_human,
          clientReference: args.client_reference,
          fromCartId: args.from_cart_id,
          idempotencyKey: args.idempotency_key,
        });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  server.registerTool(
    "update_cart",
    {
      title: "Update a draft cart",
      description: "Replace lines or the saved shipping address on a draft cart. Requires idempotency_key.",
      inputSchema: {
        cart_id: z.string(),
        lines: z.array(z.object({
          offer_id: z.string().optional(),
          quantity: z.number().int().min(1).max(99),
          provider: z.enum(["native", "shopify", "shop"]).optional(),
          external_id: z.string().optional(),
          title: z.string().optional(),
          seller_name: z.string().optional(),
          seller_id: z.string().optional(),
          unit_price: z.number().int().optional(),
          continue_url: z.string().optional(),
          placement: z.object({
            type: z.string(),
            commission: z.object({ percentage: z.object({ value: z.number() }) }).nullable().optional(),
          }).nullable().optional(),
        })).optional(),
        shipping_address_id: z.string().optional(),
        note_for_human: z.string().max(500).optional(),
        idempotency_key: z.string().min(8),
      },
    },
    async (args, extra) =>
      tool(async () => {
        const bot = botFromExtra(extra, "cart");
        const lines = args.lines ? await verifyShopLines(args.lines.map((line) => stripClientShopLine(line as LineInput))) : undefined;
        const result = updateCart({
          bot,
          cartId: args.cart_id,
          lines,
          shippingAddressId: args.shipping_address_id,
          note: args.note_for_human,
          idempotencyKey: args.idempotency_key,
        });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  server.registerTool(
    "request_checkout",
    {
      title: "Request human checkout",
      description: "Lock price and stock and return a single-use, short-lived approval URL. The human opens it and pays. You must not complete payment or ask for card data. Shopify carts return continue_url instead of a Mercavine charge. Shop Pay carts return an approval URL first; after the human approves, get_cart includes shop_pay.continue_url. The 3% fee does not apply to Shop Pay.",
      inputSchema: {
        cart_id: z.string(),
        idempotency_key: z.string().min(8),
        allow_partial: z.boolean().optional(),
        notify: z.array(z.enum(["push", "email", "sms"])).optional(),
      },
    },
    async (args, extra) =>
      tool(() => {
        const bot = botFromExtra(extra, "buy");
        const result = submitCart({
          bot,
          cartId: args.cart_id,
          idempotencyKey: args.idempotency_key,
          allowPartial: args.allow_partial,
          notify: args.notify,
        });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get a cart",
      description: "Read the server-side cart, including status and order ids. No payment secrets.",
      inputSchema: { cart_id: z.string() },
    },
    async (args, extra) => tool(() => getCartForBot(botFromExtra(extra, "cart"), args.cart_id)),
  );

  server.registerTool(
    "cancel_cart",
    {
      title: "Cancel a cart",
      description: "Cancel a draft or a cart that is waiting for approval.",
      inputSchema: { cart_id: z.string(), reason: z.string().optional(), idempotency_key: z.string().min(8) },
    },
    async (args, extra) =>
      tool(() => {
        const result = cancelCart({ bot: botFromExtra(extra, "cart"), cartId: args.cart_id, reason: args.reason, idempotencyKey: args.idempotency_key });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  server.registerTool(
    "connect_shop_pay",
    {
      title: "Sign in with Shop",
      description: "Start Sign in with Shop for this shopper. Returns a user code and verification URL only. Never returns a token, card, or payment credential.",
      inputSchema: { device_name: z.string().max(64).optional() },
    },
    async (args, extra) =>
      tool(async () => {
        const bot = botFromExtra(extra, "buy");
        return startShopLink(bot.user_id, args.device_name || bot.name);
      }),
  );

  server.registerTool(
    "shop_pay_status",
    {
      title: "Shop Pay link status",
      description: "Whether this shopper has linked Shop Pay. Does not return tokens or card data.",
      inputSchema: {},
    },
    async (_args, extra) => tool(() => shopLinkPublic(botFromExtra(extra, "cart").user_id)),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "List the shopper's orders. Optionally filter by cart_id.",
      inputSchema: { cart_id: z.string().optional() },
    },
    async (args, extra) => tool(() => ({ orders: listOrders(botFromExtra(extra, "track"), args.cart_id) })),
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description: "Status, seller, lines, totals, and tracking. When the seller connected Amazon MCF and the listing is FBA-backed, tracking can come from that fulfillment order. prime_delivery on an offer is true only when that seller is enrolled. payment_status is pending, authorized, paid, failed, or refunded. Card data is never included. Do not order on amazon.com.",
      inputSchema: { order_id: z.string() },
    },
    async (args, extra) => tool(() => getOrder(botFromExtra(extra, "track"), args.order_id)),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an order",
      description: "Cancel before the seller accepts and refund the original payment method. You cannot redirect a refund.",
      inputSchema: { order_id: z.string(), reason: z.string().optional(), idempotency_key: z.string().min(8) },
    },
    async (args, extra) =>
      tool(() => {
        const result = cancelOrder({ bot: botFromExtra(extra, "buy"), orderId: args.order_id, reason: args.reason, idempotencyKey: args.idempotency_key });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  server.registerTool(
    "request_return",
    {
      title: "Request a return",
      description: "Start a return under the seller's policy. Refunds go to the original payment method only.",
      inputSchema: {
        order_id: z.string(),
        reason: z.string(),
        lines: z.array(z.object({ line_id: z.string(), quantity: z.number().int().min(1) })),
        idempotency_key: z.string().min(8),
      },
    },
    async (args, extra) =>
      tool(() => {
        const result = requestReturn({
          bot: botFromExtra(extra, "returns"),
          orderId: args.order_id,
          reason: args.reason,
          lines: args.lines,
          idempotencyKey: args.idempotency_key,
        });
        if (result.status >= 400) throw new ApiError(result.status, "request_failed", JSON.stringify(result.body));
        return result.body;
      }),
  );

  return server;
}

export async function handleMcp(req: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const bot = token ? botByToken(token) : undefined;
  return transport.handleRequest(req, {
    authInfo: bot ? { token, clientId: bot.id, scopes: bot.scopes } : undefined,
  });
}
