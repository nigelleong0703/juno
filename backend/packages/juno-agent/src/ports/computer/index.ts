/**
 * Package-owned computer ports barrel.
 *
 * The runtime builder rewires the existing computer contract barrel to
 * this index. Host providers implement `ComputerClient` against these
 * shapes; agent tools depend only on this directory.
 */
export type { ComputerClient, ComputerClientProvider } from './client.js';
export {
  browserInputSchema,
  browserNodeSchema,
  browserResultSchema,
  parseBrowserInput,
  parseBrowserResult,
} from './browser.js';
export type { BrowserDialog, BrowserInput, BrowserNode, BrowserResult } from './browser.js';
export { MEET_URL, meetChatMessageSchema, meetInputSchema, meetResultSchema, meetStateSchema } from './meet.js';
export type { MeetChatMessage, MeetInput, MeetResult, MeetState } from './meet.js';
export {
  computerEnvironmentSchema,
  isEnvAbsolute,
  parseEnvironment,
  resolveEnvPath,
} from './environment.js';
export type { ComputerEnvironment } from './environment.js';
export {
  aborted,
  ComputerError,
  ComputerdError,
  failed,
  isComputerError,
  isComputerErrorCode,
  noScreen,
  notAllowed,
  unavailable,
  userControl,
} from './errors.js';
export type { ComputerErrorCode, ComputerHttpStatus } from './errors.js';
export { COMPUTER_RECREATED_HEADER, CONTROL_CHANGED_HEADER, MAX_INSTALL_PACKAGES, PACKAGE_NAME, parseResolution } from './types.js';
export type {
  ComputerCopyInput,
  ComputerCopyResult,
  ComputerTarget,
  InstallPackagesInput,
  InstallPackagesResult,
  ComputerMetrics,
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
  MacDesktopAction,
  MacDesktopResult,
  RecordAudioInput,
  RecordAudioResult,
  Resolution,
  Screenshot,
  SpaceRegisterInput,
  SpaceRegisterResult,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from './types.js';
export type { HomeComputer, HomeContent, HomeExtractedText, HomeFileStat, HomeSnapshot, HomeTextFormat, PlatformSkill } from './home.js';
export { homeContentSchema, homeExtractedTextSchema, homePutResultSchema, homeSnapshotSchema } from './home.js';
