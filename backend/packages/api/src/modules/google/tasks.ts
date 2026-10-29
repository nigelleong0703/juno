/** Google Tasks on the Tasks API (`tasks`): reading tools, and writing ones marked so they follow the connector level. */
import { itemsOf, PAGE, str, type Args, type HostedTool } from './shared.js';

export const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];

const LIST = { taskListId: { type: 'string', description: 'Task list id from list_task_lists (default: the main list).' } };
const TASK_FIELDS = {
  title: { type: 'string', description: 'What to do.' },
  notes: { type: 'string', description: 'Details.' },
  due: { type: 'string', description: 'Due date, RFC 3339 (e.g. 2026-10-20T00:00:00Z); Google keeps only the date.' },
};
const listPath = (args: Args) => '/lists/' + encodeURIComponent(str(args.taskListId) ?? '@default');
const taskPath = (args: Args) => listPath(args) + '/tasks/' + encodeURIComponent(str(args.taskId) ?? '');
const taskFields = (args: Args) => Object.fromEntries(['title', 'notes', 'due'].flatMap((key) => (str(args[key]) === undefined ? [] : [[key, str(args[key])]])));
const taskOf = (task: Record<string, unknown>) => ({ id: task.id, title: task.title, notes: task.notes, due: task.due, status: task.status, completed: task.completed, parent: task.parent });

export const TASKS_TOOLS: HostedTool[] = [
  {
    name: 'list_task_lists',
    title: 'List task lists',
    description: "List the owner's task lists.",
    properties: {},
    run: async (api) => ({ lists: itemsOf(await api('/users/@me/lists', { maxResults: '100' })).map((list) => ({ id: list.id, title: list.title, updated: list.updated })) }),
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List the tasks in a task list, open ones by default.',
    properties: {
      ...LIST,
      showCompleted: { type: 'boolean', description: 'Include completed tasks (default false).' },
      dueMin: { type: 'string', description: 'Only tasks due on or after this RFC 3339 time.' },
      dueMax: { type: 'string', description: 'Only tasks due before this RFC 3339 time.' },
      pageToken: PAGE.pageToken,
    },
    run: async (api, args) => {
      const showCompleted = args.showCompleted === true ? 'true' : 'false';
      const body = await api(listPath(args) + '/tasks', { maxResults: '100', showCompleted, showHidden: showCompleted, dueMin: str(args.dueMin), dueMax: str(args.dueMax), pageToken: str(args.pageToken) });
      return { tasks: itemsOf(body).map(taskOf), ...(typeof body.nextPageToken === 'string' ? { nextPageToken: body.nextPageToken } : {}) };
    },
  },
  {
    name: 'create_task',
    title: 'Add a task',
    description: 'Add a task to a task list.',
    properties: { ...LIST, ...TASK_FIELDS },
    required: ['title'],
    writes: true,
    run: async (api, args) => taskOf(await api(listPath(args) + '/tasks', {}, { method: 'POST', body: taskFields(args) })),
  },
  {
    name: 'update_task',
    title: 'Change a task',
    description: "Change a task's title, notes or due date.",
    properties: { ...LIST, taskId: { type: 'string', description: 'Task id from list_tasks.' }, ...TASK_FIELDS },
    required: ['taskId'],
    writes: true,
    run: async (api, args) => taskOf(await api(taskPath(args), {}, { method: 'PATCH', body: taskFields(args) })),
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Mark a task as done.',
    properties: { ...LIST, taskId: { type: 'string', description: 'Task id from list_tasks.' } },
    required: ['taskId'],
    writes: true,
    run: async (api, args) => taskOf(await api(taskPath(args), {}, { method: 'PATCH', body: { status: 'completed' } })),
  },
];
