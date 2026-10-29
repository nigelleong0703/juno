import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTime } from "./RelativeTime";

const NOW = new Date("2026-01-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("RelativeTime", () => {
  it("uses 'now' for the current moment", () => {
    render(<RelativeTime date={NOW} />);
    expect(screen.getByText("now")).toBeInTheDocument();
  });

  it("formats minutes, hours and days relative to the clock", () => {
    const { rerender } = render(<RelativeTime date={secondsAgo(3 * 60)} />);
    expect(screen.getByText("3 minutes ago")).toBeInTheDocument();

    rerender(<RelativeTime date={secondsAgo(2 * 60 * 60)} />);
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();

    rerender(<RelativeTime date={secondsAgo(2 * 24 * 60 * 60)} />);
    expect(screen.getByText("2 days ago")).toBeInTheDocument();
  });

  it("formats future dates with sensible granularity", () => {
    render(<RelativeTime date={new Date(NOW.getTime() + 5 * 60 * 1000)} />);
    expect(screen.getByText("in 5 minutes")).toBeInTheDocument();
  });

  it("accepts an ISO string and exposes a machine-readable datetime", () => {
    render(<RelativeTime date="2026-01-15T11:57:00.000Z" />);
    const time = screen.getByText("3 minutes ago");
    expect(time).toHaveAttribute("datetime", "2026-01-15T11:57:00.000Z");
    expect(time).toHaveAttribute("title");
  });

  it("renders a fallback for an invalid date", () => {
    render(<RelativeTime date="not-a-date" />);
    expect(screen.getByText("Invalid date")).toBeInTheDocument();
  });
});
