// Computer surface (E2) — the right-hand pane and everything it draws.
export { ComputerPane, type ComputerPaneProps } from "./ComputerPane";
export { ComputerView, type ComputerViewProps } from "./ComputerView";
export { ComputerPreviewCard, type ComputerPreviewCardProps } from "./ComputerPreviewCard";
export { ControlBanner, type ControlBannerProps } from "./ControlBanner";
export { SelectScreenMenu, type SelectScreenMenuProps } from "./SelectScreenMenu";
export { ScreenPlaceholder, type ScreenPlaceholderProps } from "./ScreenPlaceholder";
export {
  LiveScreen,
  type LiveScreenProps,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_ASPECT,
} from "./LiveScreen";
export { ComputerStatePill, type ComputerStatePillProps } from "./ComputerStatePill";
export { ResourceMeters, type ResourceMetersProps } from "./ResourceMeters";

// Panels
export { OverviewPanel, type OverviewPanelProps } from "./panels/OverviewPanel";
export { RoutinesPanel, type RoutinesPanelProps } from "./panels/RoutinesPanel";
export { FilesPanel, type FilesPanelProps } from "./panels/FilesPanel";
export { MembersPanel, type MembersPanelProps } from "./panels/MembersPanel";
export { TasksPanel, type TasksPanelProps } from "./panels/TasksPanel";

// Live screen adapters
export { NoVncSurface, type NoVncSurfaceProps } from "./live/NoVncSurface";
export { useRfb, type UseRfbOptions, type UseRfbResult } from "./live/useRfb";
export { createRfbAdapter, type RfbLike, type RfbConstructor } from "./live/rfb";

// Hooks + pure helpers
export { useComputerPower } from "./power";
export { useComputerState, resolveComputerState, resolveAgentComputer, type ComputerStateInfo } from "./useScreenState";
export {
  resolveAgentScreen,
  useAgentScreen,
  useComputerScreens,
  useEnsureComputer,
  useEnsureScreen,
  useScreenControl,
  useScreenStreamTicket,
  useSelectedScreenAgent,
} from "../../data/screens";
export {
  deriveScenario,
  resolveHeaderState,
  deriveScreenMode,
  modeIsInteractive,
  modePausesModel,
  resolveScreenPresence,
  screenStateToComputerState,
  screenStreamUrl,
  type ScreenPresence,
  SCENARIO_BY_AGENT,
  HEADER_STATE_LABEL,
  HEADER_STATE_TONE,
} from "./modes";

// Types
export type {
  ComputerViewMode,
  HeaderState,
  ScreenScenario,
  ScreenModeInput,
  LiveScreenTarget,
  LiveScreenState,
  LiveScreenStateDetail,
  LiveScreenStateHandler,
  LiveScreenAdapter,
} from "./types";
