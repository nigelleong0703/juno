import { describe, expect, it } from 'vitest';
import { createAccount, execStack, listenEvents, queryStack, scriptedChat, stackUrls, toolCall, waitForTranscript } from '../harness/client';

/**
 * Platform skill exposure and outcome labels (BACKEND §5.15): an agent reads the platform `pdf` skill (seeded at boot from the image's
 * files), the run records which version it read, and the nightly job (run now, with the clock moved so the run counts as settled) labels
 * the run ok and credits that version. The internal admin read shows the numbers, and carries no owner id or text.
 */
describe('platform skill exposure and outcome labels', () => {
  it('records the version a run read and labels the run the next night', async () => {
    const account = await createAccount('skill-evolution');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Reader' });
      expect(agent.status).toBe(201);
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-skill', 'skill_read', { name: 'pdf' })] },
        { text: 'I read the pdf skill.' },
      ], 'how do I make a pdf?');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 60_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      const runId: string = finished.data.metadata.juno.run.id;

      const [row] = await queryStack('SELECT doc FROM runs WHERE id = ?', [runId]);
      const doc = row?.['doc'] as { skills?: Array<{ skillId: string; versionId: string; platform?: boolean }>; outcome?: string };
      expect(doc.skills).toHaveLength(1);
      expect(doc.skills?.[0]).toMatchObject({ skillId: 'pdf', platform: true });
      expect(doc.outcome).toBeUndefined();

      const { agentdUrl, internalToken } = stackUrls();
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${internalToken}` };
      const night = await fetch(`${agentdUrl}/internal/skill-evolution/run`, { method: 'POST', headers, body: JSON.stringify({ at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }), signal: AbortSignal.timeout(120_000) });
      expect(night.status).toBe(200);
      expect(((await night.json()) as { labels: { labeled: number } }).labels.labeled).toBeGreaterThanOrEqual(1);

      const [after] = await queryStack('SELECT doc FROM runs WHERE id = ?', [runId]);
      expect((after?.['doc'] as { outcome?: string }).outcome).toBe('ok');

      const read = await fetch(`${agentdUrl}/internal/skill-evolution`, { headers: { authorization: `Bearer ${internalToken}` } });
      expect(read.status).toBe(200);
      const report = (await read.json()) as { fleet: { labeled: number }; skills: Array<{ skillId: string; versions: Array<{ status: string; exposures: number; good: number }> }> };
      const pdf = report.skills.find((skill) => skill.skillId === 'pdf');
      expect(pdf?.versions.find((version) => version.status === 'active')).toMatchObject({ exposures: expect.any(Number), good: expect.any(Number) });
      expect(pdf?.versions.find((version) => version.status === 'active')?.good).toBeGreaterThanOrEqual(1);
      expect(report.fleet.labeled).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(report)).not.toContain(account.email);

      const refused = await fetch(`${agentdUrl}/internal/skill-evolution`);
      expect(refused.status).toBe(401);
    } finally {
      events.close();
    }
  });
});

/**
 * The prompt lists a bounded part of the platform catalog and says how many more there are; skill_search still finds the rest and skill_read loads
 * one. The image ships 12 skills; 14 more plus one that sorts last make the last one the 27th, past the prompt's list budget.
 */
describe('platform skills beyond the prompt budget', () => {
  it('lists a count of the rest, and skill_search then skill_read reach the last skill', async () => {
    for (let i = 0; i < 14; i += 1) {
      const id = 'e2e-filler-' + String(i).padStart(2, '0');
      await execStack(`INSERT INTO platform_skills (id, name, seed_hash) VALUES (?, ?, 'e2e') ON CONFLICT DO NOTHING`, [id, id]);
      await execStack(`INSERT INTO platform_skill_versions (id, skill_id, version, status, origin, name, description, instructions) VALUES (?, ?, 1, 'active', 'seed', ?, 'Filler skill for the budget test.', 'Filler body.') ON CONFLICT DO NOTHING`, [id + '@1', id, id]);
      await execStack('UPDATE platform_skills SET active_version_id = ? WHERE id = ?', [id + '@1', id]);
    }
    const target = 'zz-quokka-keeper';
    await execStack(`INSERT INTO platform_skills (id, name, seed_hash) VALUES (?, ?, 'e2e') ON CONFLICT DO NOTHING`, [target, target]);
    await execStack(`INSERT INTO platform_skill_versions (id, skill_id, version, status, origin, name, description, instructions) VALUES (?, ?, 1, 'active', 'seed', ?, 'Look after quokkas at the sanctuary.', 'QUOKKA-BODY: feed the quokkas at dawn.') ON CONFLICT DO NOTHING`, [target + '@1', target, target]);
    await execStack('UPDATE platform_skills SET active_version_id = ? WHERE id = ?', [target + '@1', target]);

    const account = await createAccount('skill-budget');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Finder' });
      expect(agent.status).toBe(201);
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('find', 'skill_search', { query: 'quokka sanctuary' })] },
        { toolCalls: [toolCall('read', 'skill_read', { name: target })] },
        { text: 'Found it.' },
      ], 'who looks after quokkas?');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 60_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      const rows = await waitForTranscript(sessionKey, (all) => all.some((row) => row.includes('QUOKKA-BODY')));
      const prompt = rows.find((row) => row.includes('## Platform skills'));
      expect(prompt).toMatch(/\d+ more platform skills are not listed here\. Find them with skill_search\(query\)/);
      expect(prompt).not.toContain(target);
      expect(rows.some((row) => row.includes('- ' + target + ': Look after quokkas'))).toBe(true);
      const [run] = await queryStack('SELECT doc FROM runs WHERE id = ?', [finished.data.metadata.juno.run.id]);
      expect((run?.['doc'] as { skills?: Array<{ skillId: string; platform?: boolean }> }).skills).toEqual([expect.objectContaining({ skillId: target, platform: true })]);
    } finally {
      events.close();
    }
  });
});
