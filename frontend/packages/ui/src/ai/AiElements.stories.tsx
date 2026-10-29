import type { StoryObj } from "@storybook/react-vite";
import { ArrowUp, Mic, Plus, Sparkles } from "lucide-react";
import { CodeBlock } from "@/patterns/CodeBlock";
import { Markdown } from "@/patterns/Markdown";
import { Avatar as UiAvatar, AvatarFallback } from "@/components/ui/avatar";
import { Conversation, ConversationContent, ConversationScrollButton } from "./conversation";
import { Message, MessageContent, MessageResponse } from "./message";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, PromptInputButton } from "./prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "./tool";

const meta = {
  title: "AI/AI Elements",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

function Avatar() {
  return (
    <UiAvatar style={{ width: 28, height: 28 }}>
      <AvatarFallback className="text-xs font-medium" style={{ background: "var(--color-agent-1-soft)", color: "var(--agent-1)" }}>
        J
      </AvatarFallback>
    </UiAvatar>
  );
}

export const Conversation_: Story = {
  name: "Conversation",
  render: () => (
    <div className="flex h-[640px] w-full flex-col bg-background">
      <Conversation className="flex-1">
        <ConversationContent>
          <div className="flex items-start gap-3">
            <Avatar />
            <Message from="assistant">
              <MessageContent>
                <MessageResponse>
                  Morning. I triaged your inbox and found **6 threads that need you**.
                </MessageResponse>
              </MessageContent>
              <Reasoning defaultOpen>
                <ReasoningTrigger />
                <ReasoningContent>
                  Scanned 42 messages, ranked by sender and deadline, and grouped the ones
                  that mention an approval or a payment.
                </ReasoningContent>
              </Reasoning>
              <Tool defaultOpen>
                <ToolHeader type="tool-invocation" state="output-available" />
                <ToolContent>
                  <ToolInput input={{ mailbox: "inbox", since: "2026-10-05" }} />
                  <ToolOutput
                    output={{ triaged: 42, flagged: 6 }}
                    errorText={undefined}
                  />
                </ToolContent>
              </Tool>
            </Message>
          </div>

          <Message from="user">
            <MessageContent>
              <MessageResponse>Summarise the Acme thread and draft a reply.</MessageResponse>
            </MessageContent>
          </Message>

          <div className="flex items-start gap-3">
            <Avatar />
            <Message from="assistant">
              <MessageContent>
                <MessageResponse>
                  {`Acme asked to move the renewal to November. Here is a draft:

| Field | Value |
| --- | --- |
| To | billing@acme.example |
| Subject | Renewal timing |`}
                </MessageResponse>
                <CodeBlock
                  filename="reply.eml"
                  language="text"
                  code={"Hi Dana,\n\nNovember works — I'll send the updated order form today.\n\nBest,\nRobin"}
                />
              </MessageContent>
            </Message>
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border p-4">
        <PromptInput onSubmit={() => {}}>
          <PromptInputTextarea placeholder="Ask Juno to do something…" />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputButton aria-label="Attach">
                <Plus />
              </PromptInputButton>
              <PromptInputButton aria-label="Improve">
                <Sparkles />
              </PromptInputButton>
            </PromptInputTools>
            <div className="flex items-center gap-1">
              <PromptInputButton aria-label="Dictate">
                <Mic />
              </PromptInputButton>
              <PromptInputSubmit>
                <ArrowUp />
              </PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  ),
};

export const MarkdownRendering: Story = {
  name: "Markdown",
  render: () => (
    <div className="w-[36rem] bg-background p-6">
      <Markdown>{`## This week

- 42 messages triaged
- 2 invoices awaiting approval
- 1 routine created

> Juno asked before sending anything outside the workspace.`}</Markdown>
    </div>
  ),
};
