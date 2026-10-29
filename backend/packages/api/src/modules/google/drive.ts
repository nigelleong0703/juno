/**
 * Google Drive on the Drive API v3 (`drive`, a Google "restricted" scope like the `drive.readonly` it replaces; BACKEND 10.18.2): search,
 * list a folder and recent files, read a file as text (Docs and Slides exported as plain text, Sheets as CSV, text files as they are),
 * file details and sharing, and create and copy files. `drive.file` alone would let copy_file reach only files this app made or
 * was given. search_files, create_file, copy_file, get_file_metadata, get_file_permissions, list_recent_files and read_file_content
 * carry the names and arguments of Google's Drive MCP server (https://developers.google.com/workspace/drive/api/reference/mcp);
 * list_folder is ours. Wording after github.com/taylorwilsdon/google_workspace_mcp (MIT).
 */
import { clip, itemsOf, nextPage, page, PAGE, str, type HostedTool } from './shared.js';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
const G_APPS = 'application/vnd.google-apps.';
/** What Drive turns an uploaded file into unless told not to (the official create_file does the same). */
const CONVERTED: Record<string, string> = {
  'text/plain': G_APPS + 'document',
  'text/html': G_APPS + 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': G_APPS + 'document',
  'text/csv': G_APPS + 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': G_APPS + 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': G_APPS + 'presentation',
};
const CONTENT_LIMIT = 50_000;
const FIELDS = 'id,name,mimeType,modifiedTime,size,owners(displayName),webViewLink,parents';
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

/** Drive query literals are single-quoted with backslash escapes. */
const quoted = (value: string) => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

const fileOf = (file: Record<string, unknown>) => ({
  id: file.id,
  name: file.name,
  type: file.mimeType,
  modified: file.modifiedTime,
  size: file.size,
  owner: Array.isArray(file.owners) ? Reflect.get((file.owners[0] as object | undefined) ?? {}, 'displayName') : undefined,
  url: file.webViewLink,
});

const isText = (mimeType: string) => mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType);

export const DRIVE_TOOLS: HostedTool[] = [
  {
    name: 'search_files',
    title: 'Search files',
    description: 'Search Drive by words in the file name or contents, optionally by type; newest first. Includes files shared with the owner.',
    properties: {
      query: { type: 'string', description: 'Words to find in names and contents.' },
      mimeType: { type: 'string', description: 'Only this type, e.g. application/vnd.google-apps.document, application/pdf.' },
      ...PAGE,
    },
    run: async (api, args) => {
      const terms = ['trashed = false', ...(str(args.query) === undefined ? [] : ['fullText contains ' + quoted(str(args.query) ?? '')]), ...(str(args.mimeType) === undefined ? [] : ['mimeType = ' + quoted(str(args.mimeType) ?? '')])];
      const body = await api('/files', { q: terms.join(' and '), fields: 'nextPageToken,files(' + FIELDS + ')', orderBy: str(args.query) === undefined ? 'modifiedTime desc' : undefined, ...page(args, { size: 'pageSize' }) });
      return { files: itemsOf(body, 'files').map(fileOf), ...nextPage(body) };
    },
  },
  {
    name: 'list_folder',
    title: 'List a folder',
    description: 'List what is in a folder, folders first.',
    properties: { folderId: { type: 'string', description: 'Folder id (default: My Drive).' }, ...PAGE },
    run: async (api, args) => {
      const body = await api('/files', { q: quoted(str(args.folderId) ?? 'root') + ' in parents and trashed = false', fields: 'nextPageToken,files(' + FIELDS + ')', orderBy: 'folder,name', ...page(args, { size: 'pageSize' }) });
      return { files: itemsOf(body, 'files').map(fileOf), ...nextPage(body) };
    },
  },
  {
    name: 'read_file_content',
    title: 'Read a file',
    description: 'Read a file as text: Google Docs and Slides as plain text, Sheets as CSV (first sheet), text files as they are. Other files (PDFs, images) return their details and link only.',
    properties: { fileId: { type: 'string', description: 'File id from search_files or list_folder.' } },
    required: ['fileId'],
    run: async (api, args) => {
      const path = '/files/' + encodeURIComponent(str(args.fileId) ?? '');
      const file = await api(path, { fields: FIELDS, supportsAllDrives: 'true' });
      const mimeType = String(file.mimeType ?? '');
      const exportAs = EXPORTS[mimeType];
      if (exportAs !== undefined) return { ...fileOf(file), content: clip(await api.text(path + '/export', { mimeType: exportAs }), CONTENT_LIMIT) };
      if (isText(mimeType)) return { ...fileOf(file), content: clip(await api.text(path, { alt: 'media', supportsAllDrives: 'true' }), CONTENT_LIMIT) };
      return { ...fileOf(file), content: null, note: 'Not a text file; open the link to view it.' };
    },
  },
  {
    name: 'get_file_metadata',
    title: 'File details',
    description: 'Details of one file: name, type, size, owner, times, link, folder and whether it is shared.',
    properties: { fileId: { type: 'string', description: 'File id.' } },
    required: ['fileId'],
    run: async (api, args) => {
      const file = await api('/files/' + encodeURIComponent(str(args.fileId) ?? ''), { fields: FIELDS + ',createdTime,shared,description,starred,trashed', supportsAllDrives: 'true' });
      return { ...fileOf(file), created: file.createdTime, shared: file.shared, description: file.description, starred: file.starred, trashed: file.trashed, parents: file.parents };
    },
  },
  {
    name: 'get_file_permissions',
    title: 'Who can open a file',
    description: 'Who a file is shared with and how (owner, editor, commenter, reader; anyone with the link).',
    properties: { fileId: { type: 'string', description: 'File id.' } },
    required: ['fileId'],
    run: async (api, args) => {
      const body = await api('/files/' + encodeURIComponent(str(args.fileId) ?? '') + '/permissions', { fields: 'permissions(id,type,role,emailAddress,displayName,domain)', supportsAllDrives: 'true', pageSize: '100' });
      return { permissions: itemsOf(body, 'permissions').map((entry) => ({ type: entry.type, role: entry.role, email: entry.emailAddress, name: entry.displayName, domain: entry.domain })) };
    },
  },
  {
    name: 'list_recent_files',
    title: 'Recent files',
    description: 'The files the owner worked on lately, most recent first.',
    properties: {
      orderBy: { type: 'string', enum: ['recency', 'lastModified', 'lastModifiedByMe'], description: 'recency (default), lastModified (by anyone) or lastModifiedByMe.' },
      pageSize: { type: 'integer', minimum: 1, maximum: 50, description: 'How many files (default 10).' },
      pageToken: PAGE.pageToken,
      excludeContentSnippets: { type: 'boolean', description: 'Accepted for compatibility; no snippets are returned.' },
    },
    run: async (api, args) => {
      const order = { lastModified: 'modifiedTime desc', lastModifiedByMe: 'modifiedByMeTime desc' }[str(args.orderBy) ?? ''] ?? 'viewedByMeTime desc';
      const body = await api('/files', { q: 'trashed = false', fields: 'nextPageToken,files(' + FIELDS + ')', orderBy: order, ...page({ maxResults: args.pageSize, pageToken: args.pageToken }, { size: 'pageSize' }) });
      return { files: itemsOf(body, 'files').map(fileOf), ...nextPage(body) };
    },
  },
  {
    name: 'create_file',
    title: 'Create a file',
    description: 'Create a file or folder in Drive, optionally with content. Text and CSV become a Google Doc or Sheet unless disableConversionToGoogleType is true. A folder: mimeType application/vnd.google-apps.folder and no content.',
    properties: {
      title: { type: 'string', description: 'File name.' },
      contentMimeType: { type: 'string', description: 'Type of the content, e.g. text/plain, text/csv, text/html, application/pdf. Required with content.' },
      textContent: { type: 'string', description: 'UTF-8 text content (not with base64Content).' },
      base64Content: { type: 'string', description: 'Base64 content (not with textContent).' },
      mimeType: { type: 'string', description: 'Type of an empty file or folder to create, e.g. application/vnd.google-apps.folder or application/vnd.google-apps.document.' },
      parentId: { type: 'string', description: 'Folder to put it in (default: My Drive).' },
      disableConversionToGoogleType: { type: 'boolean', description: 'Keep the uploaded type instead of converting to a Google Doc, Sheet or Slides.' },
    },
    required: ['title'],
    writes: true,
    run: async (api, args) => {
      const text = str(args.textContent);
      const base64 = str(args.base64Content);
      if (text !== undefined && base64 !== undefined) throw new Error('Give textContent or base64Content, not both');
      const parent = str(args.parentId);
      const metadata = { name: str(args.title), ...(parent === undefined ? {} : { parents: [parent] }) };
      if (text === undefined && base64 === undefined) {
        return fileOf(await api('/files', { fields: FIELDS, supportsAllDrives: 'true' }, { method: 'POST', body: { ...metadata, ...(str(args.mimeType) === undefined ? {} : { mimeType: str(args.mimeType) }) } }));
      }
      const contentType = str(args.contentMimeType);
      if (contentType === undefined) throw new Error('contentMimeType is required with content');
      const target = args.disableConversionToGoogleType === true ? undefined : CONVERTED[contentType];
      const boundary = 'juno-' + Math.random().toString(36).slice(2);
      const body = [
        '--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ ...metadata, ...(target === undefined ? {} : { mimeType: target }) }),
        '--' + boundary, 'Content-Type: ' + contentType, ...(base64 === undefined ? [] : ['Content-Transfer-Encoding: base64']), '', text ?? base64 ?? '',
        '--' + boundary + '--', '',
      ].join('\r\n');
      return fileOf(await api('/upload/drive/v3/files', { uploadType: 'multipart', fields: FIELDS, supportsAllDrives: 'true' }, { method: 'POST', body, contentType: 'multipart/related; boundary=' + boundary }));
    },
  },
  {
    name: 'copy_file',
    title: 'Copy a file',
    description: 'Make a copy of a file, optionally with a new name or in another folder.',
    properties: {
      fileId: { type: 'string', description: 'The file to copy.' },
      title: { type: 'string', description: 'Name of the copy (default "Copy of" and the original name).' },
      parentId: { type: 'string', description: "Folder for the copy (default: the original's folder)." },
    },
    required: ['fileId'],
    writes: true,
    run: async (api, args) => {
      const parent = str(args.parentId);
      return fileOf(await api('/files/' + encodeURIComponent(str(args.fileId) ?? '') + '/copy', { fields: FIELDS, supportsAllDrives: 'true' }, {
        method: 'POST',
        body: { ...(str(args.title) === undefined ? {} : { name: str(args.title) }), ...(parent === undefined ? {} : { parents: [parent] }) },
      }));
    },
  },
];
