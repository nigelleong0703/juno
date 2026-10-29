import { Button } from "@agent-desktop/ui";
import { AtSign, Clock, FileText, Monitor } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { JunoBean } from "../../components/brand/JunoBean";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";
import "./PlatformIntro.css";

interface PlatformIntroProps {
  onComplete: () => void;
}

const SCENE_COUNT = 3;
const GROUP_DEMO_IDS = ["pintro-demo-juno", "pintro-demo-aria", "pintro-demo-reno"];

/**
 * Three-scene platform introduction shown before the first-agent naming form
 * (UI102). Scene 1 defines Vomu as persistent assistants you chat with,
 * scene 2 covers team groups and @mentions (Apple Messages grouped identity),
 * scene 3 covers computer/files/routines with an honest availability note.
 * Illustrations are still schematics built from the real AgentAvatar and
 * neutral surfaces — never live status, spinners or progress. Manual
 * navigation only: no timers, no autoadvance. Entrance and stagger
 * animations run once per scene mount; reduced motion shows still frames.
 */
export function PlatformIntro({ onComplete }: PlatformIntroProps) {
  const [index, setIndex] = useState(0);

  const last = index === SCENE_COUNT - 1;

  function goBack(): void {
    if (index > 0) setIndex(index - 1);
  }

  function goNext(): void {
    if (!last) setIndex(index + 1);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goNext();
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goBack();
    }
  }

  return (
    <div
      data-slot="platform-intro"
      className="pintro-root"
      onKeyDown={handleKeyDown}
    >
      <div className="pintro-topbar">
        <p className="pintro-eyebrow">{FIRST_AGENT_COPY.introEyebrow}</p>
        <button type="button" className="pintro-skip" onClick={onComplete}>
          {FIRST_AGENT_COPY.introSkip}
        </button>
      </div>
      <div className="pintro-viewport">
        <section
          key={index}
          className="pintro-scene"
          aria-label={sceneTitle(index)}
        >
          <div className="pintro-illustration" aria-hidden="true">
            {renderIllustration(index)}
          </div>
          <h2 className="pintro-title">{sceneTitle(index)}</h2>
          <p className="pintro-body">{sceneBody(index)}</p>
          {index === 0 ? (
            <p className="pintro-platform">{FIRST_AGENT_COPY.introPlatformLine}</p>
          ) : null}
          {index === SCENE_COUNT - 1 ? (
            <p className="pintro-note">{FIRST_AGENT_COPY.introScene3Note}</p>
          ) : null}
        </section>
      </div>
      <div className="pintro-dots" role="group" aria-label={FIRST_AGENT_COPY.introEyebrow}>
        {[0, 1, 2].map((scene) => (
          <button
            key={scene}
            type="button"
            className="pintro-dot"
            aria-label={FIRST_AGENT_COPY.introGoToScene + " " + (scene + 1)}
            aria-current={scene === index ? "true" : undefined}
            onClick={() => setIndex(scene)}
          />
        ))}
      </div>
      <div className="pintro-nav">
        {index > 0 ? (
          <button type="button" className="pintro-skip" onClick={goBack}>
            {FIRST_AGENT_COPY.introBack}
          </button>
        ) : (
          <span className="pintro-step">
            {FIRST_AGENT_COPY.introStep} {index + 1} {FIRST_AGENT_COPY.introOf} {SCENE_COUNT}
          </span>
        )}
        {index > 0 ? (
          <span className="pintro-step">
            {FIRST_AGENT_COPY.introStep} {index + 1} {FIRST_AGENT_COPY.introOf} {SCENE_COUNT}
          </span>
        ) : null}
        {last ? (
          <Button variant="primary" size="sm" onClick={onComplete}>
            {FIRST_AGENT_COPY.introStart}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={goNext}>
            {FIRST_AGENT_COPY.introNext}
          </Button>
        )}
      </div>
    </div>
  );
}

function sceneTitle(index: number): string {
  if (index === 1) return FIRST_AGENT_COPY.introScene2Title;
  if (index === 2) return FIRST_AGENT_COPY.introScene3Title;
  return FIRST_AGENT_COPY.introScene1Title;
}

function sceneBody(index: number): string {
  if (index === 1) return FIRST_AGENT_COPY.introScene2Body;
  if (index === 2) return FIRST_AGENT_COPY.introScene3Body;
  return FIRST_AGENT_COPY.introScene1Body;
}

function renderIllustration(index: number): ReactNode {
  if (index === 1) return <GroupIllustration />;
  if (index === 2) return <CapabilityIllustration />;
  return <ChatIllustration />;
}

/** Scene 1: one persistent assistant and a short two-bubble exchange. */
function ChatIllustration(): ReactNode {
  return (
    <div className="pintro-chat-stack">
      <div className="pintro-bubble-row pintro-bubble-user pintro-stagger-1">
        <span className="pintro-bubble">Plan my Kyoto trip for spring</span>
      </div>
      <div className="pintro-bubble-row pintro-stagger-2">
        <JunoBean height={40} />
        <span className="pintro-bubble pintro-bubble-agent">
          Let’s compare routes and places to stay.
        </span>
      </div>
    </div>
  );
}

/** Scene 2: grouped team identities with a @mention callout. */
function GroupIllustration(): ReactNode {
  return (
    <div className="pintro-mention-stack">
      <div className="pintro-group-row pintro-stagger-1">
        {GROUP_DEMO_IDS.map((id, position) => (
          <span key={id} style={{ marginLeft: position === 0 ? 0 : -14 }}>
            <AgentAvatar agentId={id} size={44} />
          </span>
        ))}
      </div>
      <span className="pintro-mention-chip pintro-mention-active pintro-stagger-2">
        <AtSign size={12} aria-hidden="true" /> Juno, take the itinerary
      </span>
      <span className="pintro-mention-chip pintro-stagger-3">
        <AtSign size={12} aria-hidden="true" /> Aria, find the fares
      </span>
    </div>
  );
}

/** Scene 3: capability tiles — a static schematic, never live status. */
function CapabilityIllustration(): ReactNode {
  return (
    <div className="pintro-capability-row">
      <span className="pintro-capability pintro-stagger-1">
        <Monitor size={20} aria-hidden="true" />
        {FIRST_AGENT_COPY.introComputer}
      </span>
      <span className="pintro-capability pintro-stagger-2">
        <FileText size={20} aria-hidden="true" />
        {FIRST_AGENT_COPY.introFiles}
      </span>
      <span className="pintro-capability pintro-stagger-3">
        <Clock size={20} aria-hidden="true" />
        {FIRST_AGENT_COPY.introRoutines}
      </span>
    </div>
  );
}
