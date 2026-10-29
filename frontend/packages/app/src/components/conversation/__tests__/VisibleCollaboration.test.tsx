import type { ApiClient, Conversation, Item } from '@agent-desktop/client';
import { createMockClient } from '@agent-desktop/test-fixtures';
import { ThemeProvider, TooltipProvider } from '@agent-desktop/ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthContext } from '../../../auth/AuthContext';
import { ClientProvider } from '../../../data/ClientProvider';
import { createWebPlatform } from '../../../platform';
import { GroupMembers } from '../../../features/agents/pane/GroupMembers';
import { Sidebar } from '../../../shell/Sidebar';
import { useUiStore } from '../../../store/ui';
import { ConversationView } from '../ConversationView';

const at='2026-10-07T00:00:00Z';
const conversation: Conversation={id:'qa-peer',kind:'peer',agentIds:['agent-juno','agent-patch'],memberIds:['qa-owner'],unreadCount:0,lastItemAt:at,createdAt:at};
const owner={id:'qa-owner',name:'QA User',email:'fixture@example.invalid',initials:'QU'};
afterEach(cleanup);
beforeAll(()=>{class Observer implements ResizeObserver{observe(){}unobserve(){}disconnect(){}}globalThis.ResizeObserver=Observer;});
async function view(kind:Conversation['kind']='peer',withOwner=true){
 const base=createMockClient({seed:1});const agents=await Promise.all(conversation.agentIds.map(id=>base.agents.get(id)));
 const items: Item[]=agents.map((agent,i)=>({id:'qa-item-'+i,conversationId:conversation.id,at,type:'agent_message',agentId:agent.id,markdown:'QA response '+i,citations:[]}));
 render(<ThemeProvider defaultTheme="light"><TooltipProvider><AuthContext value={withOwner?{mode:'account',user:owner,signOut:()=>{}}:null}><ConversationView conversation={{...conversation,kind}} agents={agents} primaryAgent={agents[0]} items={items} isLoading={false} isError={false} computerPanelOpen={false} onRetry={()=>{}} onSend={()=>{}} onToggleComputerPanel={()=>{}} onOpenCitation={()=>{}}/></AuthContext></TooltipProvider></ThemeProvider>);
 return agents;
}
describe('visible agent collaboration',()=>{
 it('shows peer chat in the sidebar using both ordinary agent names',async()=>{
  const base=createMockClient({seed:1});const agents=await Promise.all(conversation.agentIds.map(id=>base.agents.get(id)));
  const client: ApiClient={...base,conversations:{...base.conversations,list:async()=>({items:[conversation],nextCursor:null})}};
  useUiStore.setState({sidebarCollapsed:false,sidebarSize:280});
  render(<ThemeProvider defaultTheme="light"><TooltipProvider><ClientProvider client={client} platform={createWebPlatform()}><MemoryRouter initialEntries={['/c/qa-peer']}><Sidebar/></MemoryRouter></ClientProvider></TooltipProvider></ThemeProvider>);
  await waitFor(()=>expect(screen.getByText(agents.map(a=>a.name).join(', '))).toBeDefined());
  expect(screen.queryByText('qa-peer')).toBeNull();
 });
 it('shows both peer message authors in the transcript and the group name in the header',async()=>{
  const agents=await view();
  for(const agent of agents)expect(screen.getAllByText(agent.name).length).toBeGreaterThan(0);
  expect(screen.getByRole('heading').textContent).toBe(agents.map(a=>a.name).join(', '));
 });
 async function members(kind:Conversation['kind'],withOwner:boolean){
  const client=createMockClient({seed:1});const agents=await Promise.all(conversation.agentIds.map(id=>client.agents.get(id)));
  render(<ThemeProvider defaultTheme="light"><TooltipProvider><AuthContext value={withOwner?{mode:'account',user:owner,signOut:()=>{}}:null}><ClientProvider client={client} platform={createWebPlatform()}><MemoryRouter><GroupMembers conversation={{...conversation,kind}} members={agents} onOpen={()=>{}}/></MemoryRouter></ClientProvider></AuthContext></TooltipProvider></ThemeProvider>);
  return agents;
 }
 it('lists the agents and the actual authenticated user in the members panel',async()=>{
  const agents=await members('peer',true);
  expect(await screen.findByText('QA User')).toBeDefined();expect(screen.getByText('You')).toBeDefined();
  for(const agent of agents)expect(screen.getByText('@'+agent.handle)).toBeDefined();
  expect(screen.queryByText('qa-owner')).toBeNull();
 });
 it('lists room members without inventing a current user in standalone context',async()=>{
  await members('room',false);
  expect(await screen.findByText('1 user')).toBeDefined();expect(screen.queryByText('You')).toBeNull();
 });
 it('preserves direct chat without group membership controls',async()=>{
  await view('direct');expect(screen.queryByRole('button',{name:'Show members'})).toBeNull();
 });
});
