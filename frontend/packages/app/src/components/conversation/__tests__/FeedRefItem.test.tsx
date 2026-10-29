import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedRefItem as FeedRefData } from "../../../lib/items";
import { FeedRefItem } from "../FeedRefItem";

afterEach(cleanup);

const item: FeedRefData = { type: "feed_ref", id: "i1", conversationId: "c1", at: "2026-10-15T08:00:00.000Z", agentId: "a1", feedPostId: "fp 1", title: "Mac mini prices fell" };
const Where = () => <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;

describe("FeedRefItem", () => {
  it("shows the title and 'Posted to Feed' and opens the Feed on that post", () => {
    render(
      <MemoryRouter initialEntries={["/c/c1"]}>
        <Routes>
          <Route path="*" element={<><FeedRefItem item={item} /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Mac mini prices fell")).toBeTruthy();
    fireEvent.click(screen.getByText("Posted to Feed"));
    expect(screen.getByTestId("where").textContent).toBe("/feed?post=fp%201");
  });
});
