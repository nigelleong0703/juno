import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField } from "./FormField";
import { Input } from "../primitives";

describe("FormField", () => {
  it("associates its label with the control via htmlFor", () => {
    render(
      <FormField label="Display name" htmlFor="display-name">
        <Input id="display-name" />
      </FormField>,
    );
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
  });

  it("renders the error in place of the description", () => {
    render(
      <FormField
        label="Display name"
        htmlFor="display-name"
        description="Shown to teammates"
        error="This name is taken"
      >
        <Input id="display-name" />
      </FormField>,
    );
    expect(screen.getByText("This name is taken")).toBeInTheDocument();
    expect(screen.queryByText("Shown to teammates")).not.toBeInTheDocument();
  });

  it("marks required fields with an asterisk", () => {
    render(
      <FormField label="Display name" htmlFor="display-name" required>
        <Input id="display-name" />
      </FormField>,
    );
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it(
    "links the error to the control with aria-describedby",
    () => {
      render(
        <FormField label="Display name" htmlFor="display-name" error="This name is taken">
          <Input id="display-name" />
        </FormField>,
      );

      const input = screen.getByLabelText("Display name");
      expect(input).toHaveAttribute("aria-describedby", "display-name-description");
      expect(input).toHaveAttribute("aria-invalid", "true");
    },
  );
});
