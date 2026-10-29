import type { MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeAll, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { AppDetailPage } from "../AppDetailPage";
import { AppsPage } from "../AppsPage";

/** Shared by the Apps tests: the router and providers around the pages. */

/** Radix and the scroll area measure with ResizeObserver, which jsdom lacks. */
export function stubResizeObserver(): void {
  beforeAll(() => {
    class ResizeObserverStub implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};
  });
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

/** Renders `children` (or the Apps routes when none) with the client, returning the `openExternal` spy. */
export function renderApps(client: MockClient, start: string, children?: ReactNode) {
  const openExternal = vi.fn();
  render(
    <MemoryRouter initialEntries={[start]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={{ ...webPlatform, openExternal }} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
            {children ?? (
              <Routes>
                <Route path="/apps" element={<><Path /><AppsPage /></>} />
                <Route path="/apps/:appId" element={<><Path /><AppDetailPage /></>} />
                <Route path="*" element={<Path />} />
              </Routes>
            )}
            {children ? <Path /> : null}
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  return openExternal;
}
