import { useEffect, useState } from 'react';

interface Note {
  id: number;
  text: string;
  createdAt: string;
}

export function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');

  const load = async () => setNotes(await (await fetch('/api/notes')).json());
  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    if (!text.trim()) return;
    await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    setText('');
    await load();
  };

  return (
    <main>
      <h1>Notes</h1>
      <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Write a note" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.text}</li>
        ))}
      </ul>
    </main>
  );
}
