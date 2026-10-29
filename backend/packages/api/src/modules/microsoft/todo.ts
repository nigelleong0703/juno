/** Microsoft To Do on Microsoft Graph (`/me/todo`, `Tasks.ReadWrite`): lists, tasks, add, change, complete and delete. */
import { str, type Api, type Args, type HostedTool } from '../google/shared.js';
import { bodyText, graphTime, listPage, MS_PAGE, MS_ZONE, none, rows, size, when, zoneOf } from './shared.js';

export const TODO_SCOPES = ['Tasks.ReadWrite', 'offline_access'];
const LIST = { listId: { type: 'string', description: 'Task list id from list_task_lists (default: the main Tasks list).' } };

/** The given list id, else the list Graph marks as the default one. */
async function listIdOf(api: Api, args: Args): Promise<string> {
  const given = str(args.listId);
  if (given !== undefined) return encodeURIComponent(given);
  const found = rows(await api('/me/todo/lists', { $top: '100' })).find((list) => list.wellknownListName === 'defaultList') ?? rows(await api('/me/todo/lists', { $top: '1' }))[0];
  if (found === undefined) throw new Error('No task list found');
  return encodeURIComponent(String(found.id));
}

function taskLine(task: Record<string, unknown>, zone: string | undefined): string {
  const due = typeof task.dueDateTime === 'object' && task.dueDateTime !== null ? Reflect.get(task.dueDateTime, 'dateTime') : undefined;
  const notes = bodyText(task.body, 300).replace(/\s+/g, ' ');
  return ['[' + String(task.id) + ']', task.status === 'completed' ? '(done)' : '', String(task.title ?? ''), typeof due === 'string' ? '| due ' + when(due, zone) : '', task.importance === 'high' ? '| important' : '', notes === '' ? '' : '| ' + notes].filter((part) => part !== '').join(' ');
}

export const TODO_TOOLS: HostedTool[] = [
  {
    name: 'list_task_lists',
    title: 'List task lists',
    description: "List the owner's To Do lists.",
    properties: {},
    run: async (api) => {
      const lists = rows(await api('/me/todo/lists', { $top: '100' }));
      return lists.length === 0 ? none('task lists') : lists.map((list) => '[' + String(list.id) + '] ' + String(list.displayName) + (list.wellknownListName === 'defaultList' ? ' (default)' : '')).join('\n');
    },
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List the tasks in a task list, open ones by default.',
    properties: { ...LIST, showCompleted: { type: 'boolean', description: 'Include completed tasks (default false).' }, ...MS_PAGE, ...MS_ZONE },
    run: async (api, args) => {
      const { items, more } = await listPage(api, args, '/me/todo/lists/' + (await listIdOf(api, args)) + '/tasks', { $top: size(args), ...(args.showCompleted === true ? {} : { $filter: "status ne 'completed'" }) });
      const zone = zoneOf(args);
      return items.length === 0 ? none('tasks') : items.map((task) => taskLine(task, zone)).join('\n') + more;
    },
  },
  {
    name: 'create_task',
    title: 'Add a task',
    description: 'Add a task to a task list.',
    properties: {
      ...LIST,
      title: { type: 'string', description: 'What to do.' },
      notes: { type: 'string', description: 'Details.' },
      due: { type: 'string', description: 'Due date or date and time (e.g. 2026-10-20 or 2026-10-20T17:00:00+08:00).' },
      ...MS_ZONE,
    },
    required: ['title'],
    writes: true,
    run: async (api, args) => {
      const due = str(args.due);
      const task = await api('/me/todo/lists/' + (await listIdOf(api, args)) + '/tasks', {}, {
        method: 'POST',
        body: { title: str(args.title), ...(str(args.notes) === undefined ? {} : { body: { contentType: 'text', content: str(args.notes) } }), ...(due === undefined ? {} : { dueDateTime: graphTime(due, zoneOf(args)) }) },
      });
      return 'Task added.\n' + taskLine(task, zoneOf(args));
    },
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Mark a task as done.',
    properties: { ...LIST, taskId: { type: 'string', description: 'Task id from list_tasks.' } },
    required: ['taskId'],
    writes: true,
    run: async (api, args) => {
      const task = await api('/me/todo/lists/' + (await listIdOf(api, args)) + '/tasks/' + encodeURIComponent(str(args.taskId) ?? ''), {}, { method: 'PATCH', body: { status: 'completed' } });
      return 'Marked done.\n' + taskLine(task, undefined);
    },
  },
  {
    name: 'update_task',
    title: 'Change a task',
    description: 'Change a task: only the fields given are changed. Use complete_task to finish one; reopen with status notStarted.',
    properties: {
      ...LIST,
      taskId: { type: 'string', description: 'Task id from list_tasks.' },
      title: { type: 'string', description: 'New title.' },
      notes: { type: 'string', description: 'New details.' },
      due: { type: 'string', description: 'New due date or date and time; "none" clears it.' },
      importance: { type: 'string', enum: ['low', 'normal', 'high'] },
      status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed'] },
      ...MS_ZONE,
    },
    required: ['taskId'],
    writes: true,
    run: async (api, args) => {
      const due = str(args.due);
      const task = await api('/me/todo/lists/' + (await listIdOf(api, args)) + '/tasks/' + encodeURIComponent(str(args.taskId) ?? ''), {}, {
        method: 'PATCH',
        body: {
          ...(str(args.title) === undefined ? {} : { title: str(args.title) }),
          ...(str(args.notes) === undefined ? {} : { body: { contentType: 'text', content: str(args.notes) } }),
          ...(due === undefined ? {} : { dueDateTime: due === 'none' ? null : graphTime(due, zoneOf(args)) }),
          ...(str(args.importance) === undefined ? {} : { importance: str(args.importance) }),
          ...(str(args.status) === undefined ? {} : { status: str(args.status) }),
        },
      });
      return 'Task updated.\n' + taskLine(task, zoneOf(args));
    },
  },
  {
    name: 'delete_task',
    title: 'Delete a task',
    description: 'Delete a task from a task list.',
    properties: { ...LIST, taskId: { type: 'string', description: 'Task id from list_tasks.' } },
    required: ['taskId'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/me/todo/lists/' + (await listIdOf(api, args)) + '/tasks/' + encodeURIComponent(str(args.taskId) ?? ''), {}, { method: 'DELETE' });
      return 'Task deleted.';
    },
  },
];
