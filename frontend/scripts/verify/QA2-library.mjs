import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const route=readFileSync('packages/app/src/features/library/LibraryPage.tsx','utf8');
assert.ok(/ConversationFilesPanel/.test(route),'route composes shared files panel');
assert.ok(!/\buseLibrary\b/.test(route),'route must not duplicate shared panel query/filter logic');
assert.ok(!/scoped\.filter|library\s*\?\?/.test(route),'one file filtering implementation');
console.log('QA2 single shared file panel and route adapter PASS');
