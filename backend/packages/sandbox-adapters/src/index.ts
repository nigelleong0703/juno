/**
 * \`@agent-desktop/sandbox-adapters\` — the sandbox seam plus its two providers, the display registry,
 * port map and the stream-ticket signer. computerd runs the providers and the screen pool, agentd
 * uses the tool client, environment shapes and screen tickets, and api verifies stream tickets
 * (see CONTRACT.md).
 */
export type {
  ClipboardCopyResult,
  ClipboardPaste,
  ClipboardPasteResult,
  ComputerMetrics,
  ComputerHostSpec,
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  MouseButton,
  NavigateResult,
  Point,
  ProcessOutput,
  ProcessReadInput,
  ProcessResult,
  ProcessSnapshot,
  ProcessStartInput,
  ProcessState,
  ProcessStopInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
  ProviderKind,
  Resolution,
  SandboxState,
  ScreenAction,
  ScreenActionResult,
  ScreenHandle,
  ScreenRequest,
  Screenshot,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from './types.js';
export { parseResolution } from './types.js';
export {
  BROWSER_HELPER,
  BROWSER_TIMEOUT_MS,
  browserInputSchema,
  browserResultSchema,
  browserCommand,
  parseBrowserOutput,
} from './browser.js';
export type { BrowserInput, BrowserNode, BrowserResult } from './browser.js';
export { MEET_HELPER, MEET_TIMEOUT_MS, meetCommand, meetInputSchema, meetResultSchema, parseMeetOutput } from './meet.js';
export type { MeetInput, MeetResult } from './meet.js';
export { COMPUTER_RECREATED_HEADER, CONTROL_CHANGED_HEADER, MAX_INSTALL_PACKAGES, PACKAGE_NAME } from 'juno-agent/computer';
export { agentUser, homeOwnership, installPackages, applyHomeOwnership, userScript } from './isolation.js';
export { vncPasswordKey, vncResponse, encryptDesBlock } from './des.js';
export { RfbHandshake, type RfbChannel, type Detached } from './rfb.js';
export {
  pidDir,
  pngSize,
  shq,
  startScreenScript,
  stopScreenCommand,
  userControlStartCommand,
  userControlStopCommand,
  xdotoolClick,
  xdotoolScroll,
  type ScreenBootRequest,
} from './screen-boot.js';
export { METRICS_COMMAND, parseMetrics } from './metrics.js';
export { runScreenAction } from './screen-actions.js';
export { createSandboxProcesses, MAX_PROCESS_READ_BYTES, PROCESS_ROOT, type SandboxProcesses } from './processes.js';
export type { CommandResult, RuntimeOptions, SandboxRuntime } from './runtime.js';
export { createSandboxHome, parseSnapshot, snapshotScript, type SandboxHome } from './home.js';
export { createKeyedMutex, type KeyedMutex } from './mutex.js';
export type { ComputerProvider, EraseReport } from './provider.js';
export { createMacSide, createSandboxSide, type PathKind, type TransferSide } from './path-transfer.js';
export { GATEWAY_PORT, SPACE_ID, SPACE_PORTS, listenerProblem, parseListeners, type ListeningPort, type SpaceRegistration } from './spaces.js';
export {
  computerEnvironmentSchema,
  ENVIRONMENT_COMMAND,
  isEnvAbsolute,
  parseEnvironment,
  parseEnvironmentOutput,
  resolveEnvPath,
  type ComputerEnvironment,
} from './environment.js';
export type { ComputerClient, ComputerClientProvider } from './client.js';
export { createE2bProvider, type E2bProviderOptions } from './e2b.js';
export { createE2bDriver, type E2bDriverOptions } from './e2b-driver.js';
export { createDockerCli, type DockerCli } from './docker-cli.js';
export { createDockerDriver, runArguments, type DockerDriverOptions } from './docker-driver.js';
export type { CreateSpec, LifecycleDriver, LinkEnv, MachineState } from './driver.js';
export { createLinkedProvider, type LinkedProviderOptions, type StartedContext } from './linked-provider.js';
export { createLinkHub, streamConnector, type ExecOutput, type LinkConnection, type LinkHub, type LinkHubOptions, type LinkStream } from './link-hub.js';
export { createLinkRuntime } from './link-runtime.js';
export { httpOverStream, type LinkResponse } from './link-http.js';
export { agentRuntime, prepareForAgent } from './isolation.js';
export { relaunchSpaces, type RelaunchDeps } from './space-relaunch.js';
export { isIdempotentAction } from './action-policy.js';
export { isDockerMissing } from './local-container.js';
export { createFakeProvider, type FakeProvider, type FakeProviderOptions } from './fake.js';
export { createLocalProvider, type LocalProviderOptions } from './local.js';
export {
  createScreenPool,
  loadPool,
  savePool,
  type PoolEntry,
  type PoolLease,
  type ScreenPool,
} from './register.js';
export { FIRST_SCREEN_DISPLAY, MAX_LIVE_SCREENS, screenPorts } from './ports.js';
export {
  ComputerdError,
  aborted,
  failed,
  homeConflict,
  noScreen,
  notAllowed,
  unavailable,
  userControl,
  BrowserDownError,
  StaleComputerError,
  computerRecovering,
  type StaleReason,
  type ComputerErrorCode,
  type ComputerHttpStatus,
} from './errors.js';
export {
  signScreenTicket,
  verifyScreenTicket,
  type ScreenTicketClaims,
} from './ticket.js';
export { loadComputerConfig, computerConfigSchema, computerSize, type ComputerConfig } from './config.js';
export { volumeNames, juicefsTargets, computerStorage, createComputerStorage, type ComputerStorage, type StorageSettings } from './storage.js';
