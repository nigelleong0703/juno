import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./Collapsible";

describe("Collapsible", () => {
  it("starts collapsed and expands when the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>Advanced</CollapsibleTrigger>
        <CollapsibleContent>Hidden settings</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: "Advanced" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Hidden settings")).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Hidden settings")).toBeInTheDocument();
  });

  it("collapses again when the trigger is clicked twice", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>Advanced</CollapsibleTrigger>
        <CollapsibleContent>Hidden settings</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: "Advanced" });
    await user.click(trigger);
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Hidden settings")).not.toBeInTheDocument();
  });

  it("honours defaultOpen", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Advanced</CollapsibleTrigger>
        <CollapsibleContent>Hidden settings</CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.getByText("Hidden settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
