import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAgent } from '../src/agent.js';
import { runAgent } from '../src/control/loop.js';
import {
  SKILL_LIST_TOOL,
  SKILL_READ_TOOL,
  SKILLS_CATALOG_MARKER,
  delegateToolName,
  loadSkillFile,
  parseSkillMarkdown,
} from '../src/skills/index.js';
import {
  MockToolInvoker,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

const SAMPLE_MD = `---
name: clarify
description: Ask targeted questions before coding
loadMode: on_demand
---

# Clarification

1. List ambiguities
2. Ask the user
`;

describe('parseSkillMarkdown / loadSkillFile', () => {
  it('parses frontmatter name, description, loadMode and body', () => {
    const skill = parseSkillMarkdown(SAMPLE_MD);
    expect(skill.name).toBe('clarify');
    expect(skill.description).toBe('Ask targeted questions before coding');
    expect(skill.loadMode).toBe('on_demand');
    expect(skill.body).toContain('# Clarification');
    expect(skill.body).toContain('List ambiguities');
  });

  it('allows opts.name override and rejects missing description', () => {
    expect(() => parseSkillMarkdown('# no frontmatter')).toThrow(/name/);
    expect(() => parseSkillMarkdown('---\nname: x\n---\nbody')).toThrow(/description/);
    const skill = parseSkillMarkdown('---\ndescription: d\n---\nbody', { name: 'from-opts' });
    expect(skill.name).toBe('from-opts');
  });

  it('loads from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-'));
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, SAMPLE_MD);
    expect(loadSkillFile(path).name).toBe('clarify');
  });
});

describe('createAgent skills materialisation', () => {
  it('defaults to on_demand: catalog in instructions, skill tools on invoker', async () => {
    const tools = new MockToolInvoker([]);
    const agent = createAgent({
      name: 'dev',
      instructions: 'You are a developer.',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools,
      skills: [
        {
          name: 'clarify',
          description: 'Ask questions',
          body: '# Clarify\n\nAsk first.',
        },
      ],
    });

    expect(agent.resolved).toBe(true);
    expect(agent.instructions).toContain(SKILLS_CATALOG_MARKER);
    expect(agent.instructions).toContain('**clarify** (on_demand)');
    expect(agent.instructions).not.toContain('# Clarify');
    expect(agent.tools.list().map((t) => t.name)).toEqual(
      expect.arrayContaining([SKILL_LIST_TOOL, SKILL_READ_TOOL]),
    );

    const listed = await agent.tools.call(SKILL_LIST_TOOL, {});
    expect(listed).toEqual([
      expect.objectContaining({ name: 'clarify', description: 'Ask questions' }),
    ]);

    const read = await agent.tools.call(SKILL_READ_TOOL, { name: 'clarify' });
    expect(read).toEqual(
      expect.objectContaining({ name: 'clarify', body: '# Clarify\n\nAsk first.' }),
    );
  });

  it('eager skills inline the body and skip skill tools', () => {
    const agent = createAgent({
      name: 'dev',
      instructions: 'You are a developer.',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools: new MockToolInvoker([]),
      skillLoadMode: 'eager',
      skills: [{ name: 'short', description: 'Tiny playbook', body: 'Do the thing.' }],
    });

    expect(agent.instructions).toContain('## Skill: short');
    expect(agent.instructions).toContain('Do the thing.');
    expect(agent.tools.list().map((t) => t.name)).not.toContain(SKILL_LIST_TOOL);
  });

  it('supports mixed eager + on_demand per skill', async () => {
    const agent = createAgent({
      name: 'dev',
      instructions: 'base',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools: new MockToolInvoker([]),
      skills: [
        { name: 'short', description: 'inline me', body: 'EAGER BODY', loadMode: 'eager' },
        { name: 'long', description: 'fetch me', body: 'ON DEMAND BODY', loadMode: 'on_demand' },
      ],
    });

    expect(agent.instructions).toContain('EAGER BODY');
    expect(agent.instructions).not.toContain('ON DEMAND BODY');
    const read = await agent.tools.call(SKILL_READ_TOOL, { name: 'long' });
    expect(read).toEqual(expect.objectContaining({ body: 'ON DEMAND BODY' }));
    await expect(agent.tools.call(SKILL_READ_TOOL, { name: 'short' })).resolves.toMatch(/unknown skill/);
  });

  it('is idempotent when createAgent is called twice', () => {
    const once = createAgent({
      name: 'dev',
      instructions: 'base',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools: new MockToolInvoker([]),
      skills: [{ name: 'a', description: 'd', body: 'b', loadMode: 'eager' }],
    });
    const twice = createAgent(once);
    expect(twice).toBe(once);
    expect(twice.instructions.match(/## Available skills/g)?.length).toBe(1);
  });

  it('skill_read can return a named reference', async () => {
    const agent = createAgent({
      name: 'dev',
      instructions: 'base',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools: new MockToolInvoker([]),
      skills: [
        {
          name: 'spec',
          description: 'Write a spec',
          body: 'main body',
          references: { template: '## Template\n...' },
        },
      ],
    });
    const ref = await agent.tools.call(SKILL_READ_TOOL, { name: 'spec', reference: 'template' });
    expect(ref).toEqual({ name: 'spec', reference: 'template', content: '## Template\n...' });
  });

  it('surfaces SkillSpec.corpusId in catalog, skill_list, and skill_read', async () => {
    const agent = createAgent({
      name: 'dev',
      instructions: 'base',
      model: new ScriptedChatModel([finalResponse('ok')]),
      tools: new MockToolInvoker([]),
      skills: [
        {
          name: 'auth-playbook',
          description: 'Auth fixes',
          body: 'steps',
          corpusId: 'auth-docs',
        },
      ],
    });
    expect(agent.instructions).toContain('corpus: auth-docs');
    const listed = (await agent.tools.call(SKILL_LIST_TOOL, {})) as Array<{ corpusId?: string }>;
    expect(listed[0]?.corpusId).toBe('auth-docs');
    const read = (await agent.tools.call(SKILL_READ_TOOL, { name: 'auth-playbook' })) as {
      corpusId?: string;
    };
    expect(read.corpusId).toBe('auth-docs');
  });

  it('parseSkillMarkdown reads corpusId from frontmatter', () => {
    const skill = parseSkillMarkdown(`---
name: n
description: d
corpusId: payments-api
---
body`);
    expect(skill.corpusId).toBe('payments-api');
  });
});

describe('createAgent subAgents wiring', () => {
  it('exposes each sub-agent as delegate_<name> and runs nested loop', async () => {
    const subTools = new MockToolInvoker([
      makeTool('lookup', 'lookup', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, () => ({
        n: 7,
      })),
    ]);
    const subModel = new ScriptedChatModel([
      toolCallResponse([toolCall('s1', 'lookup', { q: 'x' })]),
      finalResponse('sub=7'),
    ]);
    const parentModel = new ScriptedChatModel([
      toolCallResponse([toolCall('p1', delegateToolName('lookup-agent'), { goal: 'find 7' })]),
      finalResponse('done'),
    ]);

    const agent = createAgent({
      name: 'parent',
      instructions: 'orchestrator',
      model: parentModel,
      tools: new MockToolInvoker([]),
      subAgents: [
        {
          name: 'lookup-agent',
          instructions: 'lookup specialist',
          model: subModel,
          tools: subTools,
        },
      ],
    });

    expect(agent.tools.list().map((t) => t.name)).toContain('delegate_lookup_agent');

    const res = await runAgent({ agent, goal: 'g' });
    expect(res.finished).toBe(true);
    expect(res.answer).toBe('done');
    expect(subTools.counts.lookup).toBe(1);
  });
});

describe('skills + runAgent end-to-end', () => {
  it('model can skill_read then finish', async () => {
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', SKILL_READ_TOOL, { name: 'clarify' })]),
      finalResponse('asked the user'),
    ]);
    const agent = createAgent({
      name: 'dev',
      instructions: 'Follow skills.',
      model,
      tools: new MockToolInvoker([]),
      skills: [{ name: 'clarify', description: 'Ask first', body: 'Step 1: ask.' }],
    });

    const res = await runAgent({ agent, goal: 'ship feature' });
    expect(res.finished).toBe(true);
    expect(res.toolsUsed).toContain(SKILL_READ_TOOL);
    expect(res.answer).toBe('asked the user');
  });
});
