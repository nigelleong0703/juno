import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandIcon } from "../BrandIcon";

afterEach(cleanup);

describe("BrandIcon", () => {
  it("loads the backend's icon from iconUrl, or from the id, against the server origin", () => {
    const { container, rerender } = render(<BrandIcon id="gmail" iconUrl="/v1/brand-icons/gmail.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1:8787/v1/brand-icons/gmail.png");
    rerender(<BrandIcon id="telegram" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1:8787/v1/brand-icons/telegram.png");
  });

  it("falls back to the symbol when the image fails", () => {
    const { container } = render(<BrandIcon id="nope" symbol="mail" />);
    expect(container.querySelector("svg")).not.toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
