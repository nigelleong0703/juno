/**
 * Durable storage for the user's files (BACKEND 7.10): `/juno` and `/workspace` live on storage the platform owns, so the
 * computer (an E2B sandbox or a local container) can be thrown away and rebuilt without losing them.
 *
 *  - `none`: the files stay on the computer's own disk (the old behaviour, E2B without storage configured).
 *  - `local-volume`: two Docker named volumes per user, mounted by `docker run -v`. Local Docker only; no FUSE, no object store.
 *  - `juicefs`: one JuiceFS file system per user (data in an S3-compatible bucket, metadata in Postgres), mounted by computerd
 *    as root inside the computer. Works on any FUSE-capable Linux, so it does not tie the platform to one sandbox vendor.
 *
 * Secrets never reach a command line: the mount script is constant text and the credentials travel in the environment of the
 * one root process that runs it (the local runtime delivers the script on stdin, E2B sets the process environment).
 */
import { createLogger } from '@agent-desktop/log';
import { failed } from './errors.js';
import type { DockerCli } from './docker-cli.js';
import type { ComputerConfig } from './config.js';
import { MANAGED_LABEL, OWNER_LABEL, ownerHash } from './local-container.js';
import type { SandboxRuntime } from './runtime.js';
import { PROFILE_ROOT_FILE } from './screen-boot.js';

const log = createLogger({ service: 'sandbox-storage' });

export const JUNO_MOUNT = '/juno';
export const WORKSPACE_MOUNT = '/workspace';
/**
 * Durable, agent-private state outside the `/juno` layout (BACKEND §7.11): today the Chromium profiles, one directory per
 * agent user (`/juno-private/agents/<juno-user>/chromium`, 0700, owned by that user), so a browser login survives a cold start.
 */
export const PROFILES_MOUNT = '/juno-private';
/** Root-only directory holding the whole file system mount; `/juno` and `/workspace` are bind mounts of its subdirectories. */
export const STORE_DIR = '/run/juno-private/store';
const MOUNT_TIMEOUT_MS = 180_000;

export type StorageKind = 'none' | 'local-volume' | 'juicefs';

export interface JuicefsSettings {
  kind: 'juicefs';
  /** Base metadata URL: `postgres://...` (one schema per user is derived) or `sqlite3://...` (one user; tests). */
  metaUrl: string;
  objectStorage: 's3' | 'file';
  /** What `juicefs format --bucket` takes: `<endpoint>/<bucket>` for S3, a directory for `file`. */
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type StorageSettings = { kind: 'none' } | { kind: 'local-volume' } | JuicefsSettings;

type StorageInput = Pick<
  ComputerConfig,
  'COMPUTER_PROVIDER' | 'COMPUTER_STORAGE' | 'STORAGE_META_URL' | 'STORAGE_TYPE' | 'STORAGE_S3_ENDPOINT' | 'STORAGE_S3_BUCKET' | 'STORAGE_S3_ACCESS_KEY' | 'STORAGE_S3_SECRET_KEY'
>;

/** The storage the environment asks for; throws a plain message when it is inconsistent. */
export function computerStorage(config: StorageInput): StorageSettings {
  const kind = config.COMPUTER_STORAGE ?? (config.COMPUTER_PROVIDER === 'local' ? 'local-volume' : 'none');
  if (kind === 'none') return { kind };
  if (kind === 'local-volume') {
    if (config.COMPUTER_PROVIDER !== 'local') throw new Error('COMPUTER_STORAGE=local-volume only works with COMPUTER_PROVIDER=local; use juicefs for E2B');
    return { kind };
  }
  const missing: string[] = [];
  if (!/^(postgres|postgresql|sqlite3):\/\//.test(config.STORAGE_META_URL)) missing.push('STORAGE_META_URL (postgres:// or sqlite3://)');
  if (config.STORAGE_S3_BUCKET === '') missing.push('STORAGE_S3_BUCKET');
  if (config.STORAGE_TYPE === 's3') {
    if (config.STORAGE_S3_ENDPOINT === '') missing.push('STORAGE_S3_ENDPOINT');
    if (config.STORAGE_S3_ACCESS_KEY === '') missing.push('STORAGE_S3_ACCESS_KEY');
    if (config.STORAGE_S3_SECRET_KEY === '') missing.push('STORAGE_S3_SECRET_KEY');
  }
  if (missing.length > 0) throw new Error(`COMPUTER_STORAGE=juicefs needs ${missing.join(', ')}`);
  const bucket = config.STORAGE_TYPE === 's3' ? `${config.STORAGE_S3_ENDPOINT.replace(/\/+$/, '')}/${config.STORAGE_S3_BUCKET}` : config.STORAGE_S3_BUCKET;
  return { kind, metaUrl: config.STORAGE_META_URL, objectStorage: config.STORAGE_TYPE, bucket, accessKey: config.STORAGE_S3_ACCESS_KEY, secretKey: config.STORAGE_S3_SECRET_KEY };
}

/** Stable, identity-free name derived from the owner id: the JuiceFS file system, its Postgres schema, the Docker volumes. */
const slug = (ownerId: string) => ownerHash(ownerId).slice(0, 16);
export const fileSystemName = (ownerId: string) => `juno-${slug(ownerId)}`;
export const metaSchemaName = (ownerId: string) => `jfs_${slug(ownerId)}`;
export const volumeNames = (ownerId: string) => ({ home: `juno-vol-${slug(ownerId)}-home`, workspace: `juno-vol-${slug(ownerId)}-workspace`, profiles: `juno-vol-${slug(ownerId)}-profiles` });

/**
 * What deleting an owner may touch on the JuiceFS side, derived from the owner id alone and checked against the exact shape
 * `fileSystemName` / `metaSchemaName` produce: one object-store folder and one metadata schema, never a bucket, a prefix of
 * another folder, or an empty name.
 */
export function juicefsTargets(ownerId: string): { prefix: string; schema: string } {
  if (ownerId.trim() === '') throw failed('an owner id is required to find its storage');
  const name = fileSystemName(ownerId);
  const schema = metaSchemaName(ownerId);
  if (!/^juno-[0-9a-f]{16}$/.test(name) || !/^jfs_[0-9a-f]{16}$/.test(schema)) throw failed('refusing to delete storage with an unexpected name');
  return { prefix: `${name}/`, schema };
}

/** The labels of one volume; null when it does not exist. Docker prints `Labels`, Apple `container` prints `configuration.labels`. */
async function volumeLabels(cli: DockerCli, name: string, signal: AbortSignal): Promise<Record<string, string> | null> {
  const result = await cli.run(['volume', 'inspect', name], { timeoutMs: 30_000, signal });
  const text = (result.stderr + result.stdout).trim();
  if (result.exitCode !== 0) {
    if (/no such volume|not found|does not exist/i.test(text)) return null;
    throw failed(`could not inspect volume ${name}: ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw failed(`could not read volume ${name}: unparsable inspect output`);
  }
  const entry: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof entry !== 'object' || entry === null) return null;
  const config: unknown = Reflect.get(entry, 'configuration');
  const raw: unknown = Reflect.get(entry, 'Labels') ?? (typeof config === 'object' && config !== null ? Reflect.get(config, 'labels') : undefined);
  const labels: Record<string, string> = {};
  if (typeof raw === 'object' && raw !== null) for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') labels[key] = value;
  return labels;
}

/** Root, idempotent: tell the computer where the durable profiles are (read by the screen boot and the user setup). */
export const PROFILE_ROOT_SCRIPT = `install -d -m 0711 ${PROFILES_MOUNT} && install -d -m 0700 /etc/juno && printf %s ${PROFILES_MOUNT} > ${PROFILE_ROOT_FILE}`;

/** The user's own metadata URL without its password, and the password apart (JuiceFS reads it from META_PASSWORD). */
export function userMeta(settings: JuicefsSettings, ownerId: string): { url: string; password?: string } {
  if (settings.metaUrl.startsWith('sqlite3://')) return { url: settings.metaUrl };
  const url = new URL(settings.metaUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  url.searchParams.set('search_path', metaSchemaName(ownerId));
  return password === '' ? { url: url.toString() } : { url: url.toString(), password };
}

/** The environment of the root mount process: everything the constant script reads. Never goes into an argument list. */
export function mountEnv(settings: JuicefsSettings, ownerId: string): Record<string, string> {
  const meta = userMeta(settings, ownerId);
  return {
    JFS_NAME: fileSystemName(ownerId),
    JFS_META_URL: meta.url,
    JFS_STORAGE: settings.objectStorage,
    JFS_BUCKET: settings.bucket,
    ...(meta.password === undefined ? {} : { META_PASSWORD: meta.password }),
    ...(settings.objectStorage === 's3' ? { ACCESS_KEY: settings.accessKey, SECRET_KEY: settings.secretKey } : {}),
  };
}

/**
 * Root, inside the computer, idempotent: format the user's file system on first use, mount it once under a root-only
 * directory and bind `juno/` and `workspace/` onto /juno and /workspace. A new `workspace/` copies owner, mode and default
 * ACL from the image's /workspace, so the shared-workspace rules of BACKEND 7.9 start out the same as on a plain disk.
 * `--enable-acl` is a format option and cannot be added later; the object keys are unset once the file system is formatted
 * (the mount reads them from the metadata).
 */
export const MOUNT_SCRIPT = [
  'set -eu',
  `if mountpoint -q ${JUNO_MOUNT} && mountpoint -q ${WORKSPACE_MOUNT} && mountpoint -q ${PROFILES_MOUNT}; then ${PROFILE_ROOT_SCRIPT}; exit 0; fi`,
  `[ -c /dev/fuse ] || { echo 'storage: /dev/fuse is missing; this computer cannot mount JuiceFS' >&2; exit 20; }`,
  `command -v juicefs >/dev/null 2>&1 || { echo 'storage: juicefs is not installed in this image' >&2; exit 21; }`,
  `install -d -m 0700 /run/juno-private ${STORE_DIR} /var/cache/juicefs`,
  `if ! mountpoint -q ${STORE_DIR}; then`,
  '  juicefs status "$JFS_META_URL" >/dev/null 2>&1 || juicefs format --storage "$JFS_STORAGE" --bucket "$JFS_BUCKET" --enable-acl "$JFS_META_URL" "$JFS_NAME" >/dev/null',
  '  unset ACCESS_KEY SECRET_KEY',
  `  juicefs mount -d --no-usage-report --cache-dir /var/cache/juicefs --cache-size 2048 "$JFS_META_URL" ${STORE_DIR} >/dev/null`,
  'fi',
  `mkdir -p ${JUNO_MOUNT} ${WORKSPACE_MOUNT} ${PROFILES_MOUNT} ${STORE_DIR}/juno ${STORE_DIR}/profiles`,
  `if [ ! -d ${STORE_DIR}/workspace ]; then`,
  `  mkdir ${STORE_DIR}/workspace`,
  `  chown --reference=${WORKSPACE_MOUNT} ${STORE_DIR}/workspace`,
  `  chmod --reference=${WORKSPACE_MOUNT} ${STORE_DIR}/workspace`,
  `  if command -v getfacl >/dev/null 2>&1; then getfacl -p ${WORKSPACE_MOUNT} | setfacl --set-file=- ${STORE_DIR}/workspace; fi`,
  'fi',
  `mountpoint -q ${JUNO_MOUNT} || mount --bind ${STORE_DIR}/juno ${JUNO_MOUNT}`,
  `mountpoint -q ${WORKSPACE_MOUNT} || mount --bind ${STORE_DIR}/workspace ${WORKSPACE_MOUNT}`,
  `mountpoint -q ${PROFILES_MOUNT} || mount --bind ${STORE_DIR}/profiles ${PROFILES_MOUNT}`,
  PROFILE_ROOT_SCRIPT,
].join('\n');

export interface ComputerStorage {
  readonly kind: StorageKind;
  /** `docker run` arguments that give a new local container its storage (volumes, or the FUSE device and capability). */
  dockerArgs(cli: DockerCli, ownerId: string, signal: AbortSignal): Promise<string[]>;
  /** As root in a running computer, before any agent action: make /juno and /workspace the durable ones. Idempotent. */
  attach(root: SandboxRuntime, ownerId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Account deletion, local-volume only (the volumes are objects of the local container runtime, so its driver calls this once the
   * owner's containers are gone): remove the owner's volumes that carry the owner's own labels; a volume of that name with another
   * owner's label, or none, is left alone. Returns what was removed; a volume that is already gone is fine.
   */
  removeVolumes?(cli: DockerCli, ownerId: string, signal: AbortSignal): Promise<string[]>;
  /**
   * Account deletion, juicefs only: delete the owner's file system, objects first (the bytes), then the metadata schema. Run it when
   * no computer of the owner can still have it mounted. Returns what was removed; running it again removes nothing and succeeds.
   */
  purge?(ownerId: string, signal: AbortSignal): Promise<string[]>;
}

export interface StorageDeps {
  /** juicefs + Postgres: create the user's metadata schema (computerd has the admin connection; the computer does not). */
  prepareMeta?: (schema: string) => Promise<void>;
  /** juicefs: delete every object under the folder `<prefix>` of the bucket; returns how many (computerd owns the S3 credentials and client). */
  deleteObjects?: (prefix: string) => Promise<number>;
  /** juicefs + Postgres: drop the user's metadata schema and everything in it. */
  dropMeta?: (schema: string) => Promise<void>;
}

export function createComputerStorage(settings: StorageSettings, deps: StorageDeps = {}): ComputerStorage {
  if (settings.kind === 'local-volume') {
    return {
      kind: 'local-volume',
      async dockerArgs(cli, ownerId, signal) {
        const names = volumeNames(ownerId);
        for (const name of [names.home, names.workspace, names.profiles]) {
          const created = await cli.run(['volume', 'create', '--label', `${MANAGED_LABEL}=1`, '--label', `${OWNER_LABEL}=${ownerHash(ownerId)}`, name], { signal });
          // Docker's create is idempotent; Apple's `container volume create` says "already exists".
          if (created.exitCode !== 0 && !/already exists/i.test(created.stderr + created.stdout)) throw failed(`could not create volume ${name}: ${(created.stderr || created.stdout).trim().slice(0, 300)}`);
        }
        return ['-v', `${names.home}:${JUNO_MOUNT}`, '-v', `${names.workspace}:${WORKSPACE_MOUNT}`, '-v', `${names.profiles}:${PROFILES_MOUNT}`];
      },
      async attach(root, _ownerId, signal) {
        const result = await root.run(PROFILE_ROOT_SCRIPT, { timeoutMs: 30_000, cwd: '/', ...(signal ? { signal } : {}) });
        if (result.exitCode !== 0) throw failed(`could not record the durable profile directory: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
      },
      async removeVolumes(cli, ownerId, signal) {
        const hash = ownerHash(ownerId);
        const removed: string[] = [];
        for (const name of Object.values(volumeNames(ownerId))) {
          const labels = await volumeLabels(cli, name, signal);
          if (labels === null) continue;
          if (labels[OWNER_LABEL] !== hash || labels[MANAGED_LABEL] !== '1') {
            log.warn({ volume: name }, 'a volume with this owner\'s name is not labelled as theirs: left alone');
            continue;
          }
          const result = await cli.run(['volume', 'rm', name], { timeoutMs: 60_000, signal });
          const text = (result.stderr + result.stdout).trim();
          if (result.exitCode !== 0 && !/no such volume|not found|does not exist/i.test(text)) throw failed(`could not remove volume ${name}: ${text.slice(0, 300)}`);
          removed.push(name);
        }
        return removed;
      },
    };
  }
  if (settings.kind === 'juicefs') {
    return {
      kind: 'juicefs',
      async dockerArgs() {
        return ['--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN'];
      },
      async attach(root, ownerId, signal) {
        if (deps.prepareMeta && !settings.metaUrl.startsWith('sqlite3://')) await deps.prepareMeta(metaSchemaName(ownerId));
        const result = await root.run(MOUNT_SCRIPT, { envs: mountEnv(settings, ownerId), timeoutMs: MOUNT_TIMEOUT_MS, cwd: '/', ...(signal ? { signal } : {}) });
        if (result.exitCode !== 0) throw failed(`could not mount durable storage: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
      },
      async purge(ownerId) {
        const { prefix, schema } = juicefsTargets(ownerId);
        const removed: string[] = [];
        if (deps.deleteObjects) removed.push(`${String(await deps.deleteObjects(prefix))} objects under ${prefix}`);
        if (deps.dropMeta && !settings.metaUrl.startsWith('sqlite3://')) {
          await deps.dropMeta(schema);
          removed.push(`metadata schema ${schema}`);
        }
        return removed;
      },
    };
  }
  return { kind: 'none', async dockerArgs() { return []; }, async attach() {} };
}
