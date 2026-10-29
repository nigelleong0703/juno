/**
 * The seam between the agent's computer tools and the sandbox backend (computerd).
 *
 * Package-owned ports (ports/computer): the ComputerClient interface, the wire shapes and the
 * error vocabulary, re-exported so callers keep one import path and tools never redefine them.
 * The tools never import a sandbox SDK: the host supplies a ComputerClient, and every call names
 * the *requesting* agent. Ownership and user takeover arrive as a ComputerError with a stable
 * code; foreign adapter errors are recognized structurally at the seam (see shared.ts).
 */
export type {
  BrowserInput,
  BrowserNode,
  BrowserResult,
  ComputerClient,
  ComputerClientProvider,
  ComputerCopyInput,
  ComputerCopyResult,
  ComputerEnvironment,
  ComputerTarget,
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  MouseButton,
  NavigateResult,
  Point,
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessStartInput,
  ProcessState,
  ProcessStopInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
  RecordAudioInput,
  RecordAudioResult,
  Screenshot,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from '../../../ports/computer/index.js';
export type { ComputerErrorCode } from '../../../ports/computer/index.js';
export { ComputerError, isComputerError } from '../../../ports/computer/index.js';
export {
  computerEnvironmentSchema,
  isEnvAbsolute,
  parseEnvironment,
  resolveEnvPath,
} from '../../../ports/computer/index.js';
export { browserInputSchema, browserResultSchema } from '../../../ports/computer/index.js';
