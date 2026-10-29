/** OneDrive on Microsoft Graph (`/me/drive`, `Files.ReadWrite`): search, list a folder (newest first), read a file as text; make a folder, save a text file, copy. */
import { clip, str, type Args, type HostedTool } from '../google/shared.js';
import { listPage, MS_PAGE, MS_ZONE, none, size, when, zoneOf } from './shared.js';
import { officeKind, officeText } from './office.js';

export const ONEDRIVE_SCOPES = ['Files.ReadWrite', 'offline_access'];
const UPLOAD_LIMIT = 4_000_000;
const parentChildren = (args: Args) => (str(args.parentId) === undefined ? '/me/drive/root/children' : '/me/drive/items/' + encodeURIComponent(str(args.parentId) ?? '') + '/children');
const CONTENT_LIMIT = 50_000;
const MAX_BYTES = 25_000_000;
const FIELDS = 'id,name,size,file,folder,lastModifiedDateTime,webUrl,lastModifiedBy';

const line = (item: Record<string, unknown>, zone: string | undefined): string =>
  '[' + String(item.id) + '] ' + String(item.name) + (item.folder === undefined ? ' | ' + String(item.size ?? '?') + ' bytes' : ' (folder)') + ' | modified ' + when(item.lastModifiedDateTime, zone) + ' | ' + String(item.webUrl ?? '');

const isText = (name: string, mime: string) => mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime) || /\.(txt|md|csv|json|xml|html?|log)$/i.test(name);

export const ONEDRIVE_TOOLS: HostedTool[] = [
  {
    name: 'search_files',
    title: 'Search files',
    description: 'Search OneDrive by words in file names and contents.',
    properties: { query: { type: 'string', description: 'Words to find.' }, ...MS_PAGE, ...MS_ZONE },
    required: ['query'],
    run: async (api, args) => {
      const query = encodeURIComponent((str(args.query) ?? '').replace(/'/g, "''"));
      const { items, more } = await listPage(api, args, "/me/drive/root/search(q='" + query + "')", { $top: size(args), $select: FIELDS });
      const zone = zoneOf(args);
      return items.length === 0 ? none('files found') : items.map((item) => line(item, zone)).join('\n') + more;
    },
  },
  {
    name: 'list_folder',
    title: 'List a folder',
    description: 'List what is in a folder, most recently changed first. Without a folderId, the top of OneDrive: use it to see recent work.',
    properties: { folderId: { type: 'string', description: 'Folder id (default: the root of OneDrive).' }, ...MS_PAGE, ...MS_ZONE },
    run: async (api, args) => {
      const folder = str(args.folderId);
      const { items, more } = await listPage(api, args, folder === undefined ? '/me/drive/root/children' : '/me/drive/items/' + encodeURIComponent(folder) + '/children', { $top: size(args), $select: FIELDS, $orderby: 'lastModifiedDateTime desc' });
      const zone = zoneOf(args);
      return items.length === 0 ? none('files in that folder') : items.map((item) => line(item, zone)).join('\n') + more;
    },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description: 'Read a file as text: Word (docx), Excel (xlsx, first sheet as tab-separated rows), PowerPoint (pptx) and text files. PDFs and other files return their details and link only.',
    properties: { fileId: { type: 'string', description: 'File id from search_files or list_folder.' } },
    required: ['fileId'],
    run: async (api, args) => {
      const path = '/me/drive/items/' + encodeURIComponent(str(args.fileId) ?? '');
      const file = await api(path, { $select: FIELDS });
      const name = String(file.name ?? '');
      const mime = String((file.file as Record<string, unknown> | undefined)?.mimeType ?? '');
      const head = line(file, undefined);
      if (file.folder !== undefined) return head + '\nThis is a folder; use list_folder.';
      const bytes = typeof file.size === 'number' ? file.size : 0;
      const kind = officeKind(name);
      if (bytes > MAX_BYTES) return head + '\nToo large to read here; open the link.';
      if (kind !== undefined) return head + '\n\n' + clip(officeText(await api.bytes(path + '/content'), kind), CONTENT_LIMIT);
      if (isText(name, mime)) return head + '\n\n' + clip(await api.text(path + '/content'), CONTENT_LIMIT);
      return head + '\nNot a file this can read as text; open the link to view it.';
    },
  },
  {
    name: 'create_folder',
    title: 'Create a folder',
    description: 'Create a folder in OneDrive (a name that exists is made unique).',
    properties: { name: { type: 'string', description: 'Folder name.' }, parentId: { type: 'string', description: 'Folder to put it in (default: the root of OneDrive).' } },
    required: ['name'],
    writes: true,
    run: async (api, args) => {
      const folder = await api(parentChildren(args), {}, { method: 'POST', body: { name: str(args.name), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' } });
      return line(folder, undefined);
    },
  },
  {
    name: 'upload_file',
    title: 'Upload a text file',
    description: 'Save text as a file in OneDrive, up to 4 MB (a file of that name in that folder is replaced). Text, Markdown, CSV and similar only.',
    properties: {
      name: { type: 'string', description: 'File name with extension, e.g. notes.md.' },
      textContent: { type: 'string', description: 'UTF-8 text of the file.' },
      parentId: { type: 'string', description: 'Folder to put it in (default: the root of OneDrive).' },
      contentType: { type: 'string', description: 'Media type (default text/plain).' },
    },
    required: ['name', 'textContent'],
    writes: true,
    run: async (api, args) => {
      const text = str(args.textContent) ?? '';
      if (Buffer.byteLength(text) > UPLOAD_LIMIT) throw new Error('Too large for a simple upload (4 MB)');
      const parent = str(args.parentId);
      const path = (parent === undefined ? '/me/drive/root' : '/me/drive/items/' + encodeURIComponent(parent)) + ':/' + encodeURIComponent(str(args.name) ?? '') + ':/content';
      return line(await api(path, {}, { method: 'PUT', body: text, contentType: str(args.contentType) ?? 'text/plain' }), undefined);
    },
  },
  {
    name: 'copy_file',
    title: 'Copy a file',
    description: 'Copy a file or folder, optionally with a new name or into another folder. OneDrive finishes the copy in the background.',
    properties: {
      fileId: { type: 'string', description: 'File or folder id.' },
      name: { type: 'string', description: 'Name of the copy.' },
      parentId: { type: 'string', description: "Folder for the copy (default: the original's folder)." },
    },
    required: ['fileId'],
    writes: true,
    run: async (api, args) => {
      const parent = str(args.parentId);
      // Graph wants the target folder's drive id beside its item id.
      const driveId = parent === undefined ? undefined : (await api('/me/drive', { $select: 'id' })).id;
      await api('/me/drive/items/' + encodeURIComponent(str(args.fileId) ?? '') + '/copy', {}, {
        method: 'POST',
        body: { ...(str(args.name) === undefined ? {} : { name: str(args.name) }), ...(parent === undefined ? {} : { parentReference: { driveId, id: parent } }) },
      });
      return 'Copy started; it appears in the folder shortly.';
    },
  },
];
