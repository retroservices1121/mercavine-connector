import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "@/lib/mcp";

describe("MCP tool annotations", () => {
  it("lists every tool with a title and ToolAnnotations", async () => {
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations?.title).toBe(t.title);
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint).toBe("boolean");
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const n of ["cancel_cart", "cancel_order", "request_return"]) {
      expect(by[n]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const n of ["search_products", "get_product", "get_cart", "shop_pay_status", "list_orders", "get_order_status"]) {
      expect(by[n]).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    await client.close();
  });
});
