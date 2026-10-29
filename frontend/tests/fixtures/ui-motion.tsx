import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { ThemeProvider, TooltipProvider } from "../../packages/ui/src/index";
import { createMockClient } from "./src/client";
import { ClientProvider } from "../../packages/app/src/data/ClientProvider";
import { webPlatform } from "../../packages/app/src/platform";
import { useUiStore } from "../../packages/app/src/store/ui";
import { AppShell } from "../../packages/app/src/shell/AppShell";
import "../../packages/web/src/index.css";

const native = new URLSearchParams(location.search).get("native") === "1";
const client = createMockClient({ seed: 5 });
client.computers.list = async () => ({ items: [], nextCursor: null });
useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
Object.assign(window, { motionFixture: { setComputer: (open: boolean) => useUiStore.getState().setComputerPanelOpen(open) } });
createRoot(document.getElementById("root")!).render(
  <ThemeProvider defaultTheme="dark"><TooltipProvider>
    <ClientProvider client={client} platform={{ ...webPlatform, hasTrafficLights: native }}>
      <MemoryRouter initialEntries={["/c/conv-juno"]}>
        <Routes><Route element={<AppShell />}>
          <Route path="c/:conversationId" element={<div style={{ height: "100%" }}><div style={{ height: 52, padding: 16 }}>Juno</div><p>Isolated layout acceptance. No account or live computer.</p></div>} />
        </Route></Routes>
      </MemoryRouter>
    </ClientProvider>
  </TooltipProvider></ThemeProvider>,
);
