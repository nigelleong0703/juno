 import { describe, expect, it, vi } from "vitest";
 import { createHttpClient } from "../client.js";

 const ISO = "2026-10-07T00:00:00.000Z";
 const CONVERSATION = {
   id: "c-1",
   kind: "direct",
   agentIds: ["agent-1"],
   memberIds: ["user-robin"],
   unreadCount: 0,
   lastItemAt: ISO,
   createdAt: ISO,
 };

 function clientFor(seen: string[]) {
   const fetch = async (url: unknown) => {
     seen.push(String(url));
     return new Response(
       JSON.stringify({ items: [CONVERSATION], nextCursor: "cursor-2" }),
       { headers: { "content-type": "application/json" } },
     );
   };
   return createHttpClient({
     baseUrl: "http://api.test",
     getToken: () => "tok",
     fetch: vi.fn(fetch),
   });
 }

 describe("conversations.list query", () => {
   it("forwards agentId and kind for an exact private lookup", async () => {
     const seen: string[] = [];
     const client = clientFor(seen);
     const result = await client.conversations.list({ agentId: "agent-1", kind: "direct" });
     expect(result.items).toHaveLength(1);
     const url = new URL(seen[0] as string);
     expect(url.pathname).toBe("/v1/conversations");
     expect(url.searchParams.get("agentId")).toBe("agent-1");
     expect(url.searchParams.get("kind")).toBe("direct");
   });

   it("forwards pagination alongside the private filters", async () => {
     const seen: string[] = [];
     const client = clientFor(seen);
     const result = await client.conversations.list({
       agentId: "agent-1",
       kind: "direct",
       limit: 50,
       cursor: "cursor-1",
     });
     expect(result.nextCursor).toBe("cursor-2");
     const url = new URL(seen[0] as string);
     expect(url.searchParams.get("agentId")).toBe("agent-1");
     expect(url.searchParams.get("kind")).toBe("direct");
     expect(url.searchParams.get("limit")).toBe("50");
     expect(url.searchParams.get("cursor")).toBe("cursor-1");
   });

   it("omits undefined filters from the query", async () => {
     const seen: string[] = [];
     const client = clientFor(seen);
     await client.conversations.list({ limit: 10 });
     const url = new URL(seen[0] as string);
     expect(url.searchParams.get("limit")).toBe("10");
     expect(url.searchParams.get("agentId")).toBeNull();
     expect(url.searchParams.get("kind")).toBeNull();
     expect(url.searchParams.get("memberId")).toBeNull();
   });
 });
