import { Button, ThemeProvider, cn } from "@agent-desktop/ui";
import { Check, Folder, Globe, Hand, Terminal } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { AvatarCharacter } from "@agent-desktop/client";
import { CHARACTER_TINT } from "../../lib/avatars";
import { AgentAvatar } from "../agent/AgentAvatar";
import "./onboarding.css";

/** Big rounded screen title shared by onboarding, connect-server and sign-in (iOS: 32pt bold rounded, -0.4 tracking). */
export const SCREEN_TITLE =
  "text-[32px] font-bold leading-[1.15] tracking-[-0.4px] text-fg [font-family:ui-rounded,'SF_Pro_Rounded',system-ui,sans-serif]";

/** What the last page offers instead of "Continue". */
export interface OnboardingFinish {
  label: string;
  onClick: () => void;
}

/** The last page's button. Web: "Get started" on to sign-in. Desktop: "Connect to a Juno server". */
export function onboardingFinish(isDesktop: boolean, onClick: () => void): OnboardingFinish {
  return { label: isDesktop ? "Connect to a Juno server" : "Get started", onClick };
}

const PAGES = [
  { title: "A team that works for you", text: "Give each agent a job. They keep going while you get on with your day." },
  { title: "Every agent has its own computer", text: "A browser, files and a terminal, always on. Watch them work any time." },
  { title: "You stay in control", text: "Agents ask before anything important. Approve, or take over the screen yourself." },
] as const;

function Figure({ character, size, phase, working, needsYou }: { character: AvatarCharacter; size: number; phase: number; working?: boolean; needsYou?: boolean }) {
  return (
    <div className="onb-bob" style={{ "--bob-delay": `${-phase / 1.6}s` } as CSSProperties}>
      <AgentAvatar agentId="" avatar={{ shape: "circle", color: 0, eyes: "dot", character }} size={size} {...(working ? { status: "working" as const } : {})} {...(needsYou ? { needsYou: true } : {})} />
    </div>
  );
}

function Wash({ character }: { character: AvatarCharacter }) {
  return <div className="onb-wash" style={{ "--wash": CHARACTER_TINT[character] } as CSSProperties} />;
}

function Tool({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex w-16 flex-col items-center gap-1.5 text-fg">
      <span className="flex h-[26px] items-center" aria-hidden>{icon}</span>
      <span className="text-xs font-medium">{title}</span>
    </div>
  );
}

function Art({ index }: { index: number }) {
  if (index === 0) {
    return (
      <>
        <Wash character="pink" />
        <div className="absolute" style={{ transform: "translate(-92px, 36px)" }}><Figure character="mint" size={96} phase={0} /></div>
        <div className="absolute" style={{ transform: "translate(92px, 36px)" }}><Figure character="blue" size={96} phase={2.1} /></div>
        <div className="absolute" style={{ transform: "translateY(-14px)" }}><Figure character="pink" size={128} phase={1} /></div>
      </>
    );
  }
  if (index === 1) {
    return (
      <>
        <Wash character="purple" />
        <div className="relative flex flex-col items-center gap-3.5">
          <Figure character="purple" size={112} phase={0.5} working />
          <div className="onb-glass flex gap-[18px] rounded-3xl px-5 py-3.5">
            <Tool icon={<Globe size={22} strokeWidth={1.6} />} title="Browser" />
            <Tool icon={<Terminal size={22} strokeWidth={1.6} />} title="Terminal" />
            <Tool icon={<Folder size={22} strokeWidth={1.6} />} title="Files" />
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <Wash character="bean" />
      <div className="relative flex flex-col items-center gap-3.5">
        <Figure character="bean" size={116} phase={1.5} needsYou />
        <div className="onb-glass flex flex-col items-center gap-3 rounded-3xl px-[22px] py-4">
          <span className="text-sm font-medium text-fg">Send the signed contract?</span>
          <div className="flex gap-2.5 text-xs font-medium text-fg">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/35 px-3.5 py-2 ring-1 ring-success/40"><Check size={13} aria-hidden />Approve</span>
            <span className="onb-glass inline-flex items-center gap-1.5 rounded-full px-3.5 py-2"><Hand size={13} aria-hidden />Take over</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Three short pages before the first sign-in (iPhone `OnboardingView`): a team that works for you, each with a
 * computer of their own, you stay in control. Skip jumps to the last page, which carries the way forward (`finish`);
 * pass `onSkip` where Skip should leave onboarding at once (web).
 */
export function OnboardingView({ finish, onSkip }: { finish: OnboardingFinish; onSkip?: () => void }) {
  const [page, setPage] = useState(0);
  const last = PAGES.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") setPage((value) => Math.min(value + 1, last));
      else if (event.key === "ArrowLeft") setPage((value) => Math.max(value - 1, 0));
      else if (event.key === "Enter" && !(event.target instanceof HTMLElement && event.target.closest("button, a, input, select, textarea"))) {
        if (page === last) finish.onClick(); else setPage(page + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, last, finish]);

  const skip = onSkip ?? (() => setPage(last));
  const showSkip = onSkip !== undefined || page < last;
  return (
    <ThemeProvider defaultTheme="dark">
    <main className="relative flex min-h-dvh w-full flex-col items-center overflow-hidden bg-background px-6 pb-10 pt-14 text-fg">
      <button
        type="button"
        onClick={skip}
        tabIndex={showSkip ? 0 : -1}
        aria-hidden={showSkip ? undefined : true}
        className={cn("focus-ring absolute right-6 top-3 h-11 rounded-md px-2 text-base font-medium text-fg-muted transition-colors hover:text-fg", !showSkip && "invisible")}
      >
        Skip
      </button>
      <div className="flex w-full max-w-[560px] flex-1 flex-col items-center justify-center">
        <div className="-my-6 w-full overflow-x-clip py-6">
          <div className="onb-track" style={{ transform: `translateX(-${page * 100}%)` }}>
            {PAGES.map((item, index) => (
              <section key={item.title} className="onb-page" aria-hidden={page === index ? undefined : true} inert={page !== index} aria-label={`${index + 1} of ${PAGES.length}`}>
                <div className="onb-art" data-current={page === index} aria-hidden><Art index={index} /></div>
                <div className="mt-7 flex flex-col items-center gap-3 px-4 text-center">
                  <h1 className={SCREEN_TITLE}>{item.title}</h1>
                  <p className="max-w-[420px] text-base leading-relaxed text-fg-muted">{item.text}</p>
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="mt-8 flex gap-2" role="tablist" aria-label="Pages">
          {PAGES.map((item, index) => (
            <button
              key={item.title}
              type="button"
              role="tab"
              aria-selected={page === index}
              aria-label={`Page ${index + 1}`}
              onClick={() => setPage(index)}
              className={cn("size-2 rounded-full transition-colors focus-ring", page === index ? "bg-fg" : "bg-fg/20 hover:bg-fg/40")}
            />
          ))}
        </div>
        <div className="mt-8 flex min-h-[112px] w-full max-w-[360px] flex-col items-center gap-2">
          {page === last ? (
            <>
              <Button variant="primary" size="lg" className="w-full" onClick={finish.onClick}>{finish.label}</Button>
            </>
          ) : (
            <Button variant="primary" size="lg" className="w-full" onClick={() => setPage(page + 1)}>Continue</Button>
          )}
        </div>
      </div>
    </main>
    </ThemeProvider>
  );
}
