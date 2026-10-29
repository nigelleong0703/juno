import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Foundations/Overview",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NEUTRALS = [
  { name: "neutral-1", className: "bg-neutral-1" },
  { name: "neutral-2", className: "bg-neutral-2" },
  { name: "neutral-3", className: "bg-neutral-3" },
  { name: "neutral-4", className: "bg-neutral-4" },
  { name: "neutral-5", className: "bg-neutral-5" },
  { name: "neutral-6", className: "bg-neutral-6" },
  { name: "neutral-7", className: "bg-neutral-7" },
  { name: "neutral-8", className: "bg-neutral-8" },
  { name: "neutral-9", className: "bg-neutral-9" },
  { name: "neutral-10", className: "bg-neutral-10" },
  { name: "neutral-11", className: "bg-neutral-11" },
  { name: "neutral-12", className: "bg-neutral-12" },
];

const ACCENTS = [
  { name: "accent-3", className: "bg-accent-3" },
  { name: "accent-5", className: "bg-accent-5" },
  { name: "accent-7", className: "bg-accent-7" },
  { name: "accent-9", className: "bg-accent-9" },
  { name: "accent-10", className: "bg-accent-10" },
];

const SEMANTIC = [
  { name: "success", base: "bg-success", subtle: "bg-success-subtle", text: "text-success" },
  { name: "warning", base: "bg-warning", subtle: "bg-warning-subtle", text: "text-warning" },
  { name: "danger", base: "bg-danger", subtle: "bg-danger-subtle", text: "text-danger" },
  { name: "info", base: "bg-info", subtle: "bg-info-subtle", text: "text-info" },
];

const AGENTS = [
  { name: "agent-1", className: "bg-agent-1" },
  { name: "agent-2", className: "bg-agent-2" },
  { name: "agent-3", className: "bg-agent-3" },
  { name: "agent-4", className: "bg-agent-4" },
  { name: "agent-5", className: "bg-agent-5" },
  { name: "agent-6", className: "bg-agent-6" },
  { name: "agent-7", className: "bg-agent-7" },
  { name: "agent-8", className: "bg-agent-8" },
  { name: "agent-9", className: "bg-agent-9" },
  { name: "agent-10", className: "bg-agent-10" },
];

const TYPE_SCALE = [
  { name: "text-2xs · 11", className: "text-2xs" },
  { name: "text-xs · 12", className: "text-xs" },
  { name: "text-sm · 13", className: "text-sm" },
  { name: "text-base · 14", className: "text-base" },
  { name: "text-md · 15", className: "text-md" },
  { name: "text-lg · 17", className: "text-lg" },
  { name: "text-xl · 22", className: "text-xl" },
  { name: "text-2xl · 26", className: "text-2xl" },
];

const SPACING = [
  { name: "1 · 4px", className: "w-1" },
  { name: "2 · 8px", className: "w-2" },
  { name: "3 · 12px", className: "w-3" },
  { name: "4 · 16px", className: "w-4" },
  { name: "5 · 20px", className: "w-5" },
  { name: "6 · 24px", className: "w-6" },
  { name: "8 · 32px", className: "w-8" },
  { name: "12 · 48px", className: "w-12" },
];

const RADII = [
  { name: "xs · 4px", className: "rounded-xs" },
  { name: "sm · 8px", className: "rounded-sm" },
  { name: "md · 10px", className: "rounded-md" },
  { name: "lg · 14px", className: "rounded-lg" },
  { name: "xl · 16px", className: "rounded-xl" },
  { name: "2xl · 18px", className: "rounded-2xl" },
  { name: "full", className: "rounded-full" },
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-8 py-6">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={`h-12 w-full rounded-sm border border-border ${className}`} />
      <span className="text-xs text-fg-muted">{name}</span>
    </div>
  );
}

export const Overview: Story = {
  render: () => (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-border px-8 py-6">
        <h1 className="text-xl font-semibold">Foundations</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Two-tier tokens: a raw palette, then semantic tokens that every component reads. Toggle the
          toolbar to compare dark and light.
        </p>
      </header>

      <Section
        title="Semantic surfaces"
        description="The tokens components are allowed to use."
      >
        <div className="grid grid-cols-4 gap-3">
          <Swatch name="bg" className="bg-bg" />
          <Swatch name="bg-subtle" className="bg-bg-subtle" />
          <Swatch name="surface" className="bg-surface" />
          <Swatch name="surface-raised" className="bg-surface-raised" />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="flex h-12 items-center justify-center rounded-sm border border-border text-sm text-fg">
            border / fg
          </div>
          <div className="flex h-12 items-center justify-center rounded-sm border border-border-strong text-sm text-fg-muted">
            border-strong / fg-muted
          </div>
          <div className="flex h-12 items-center justify-center rounded-sm border border-border text-sm text-fg-subtle">
            fg-subtle
          </div>
        </div>
      </Section>

      <Section title="Neutral scale (12 steps, cool bias)">
        <div className="grid grid-cols-12 gap-2">
          {NEUTRALS.map((c) => (
            <Swatch key={c.name} name={c.name} className={c.className} />
          ))}
        </div>
      </Section>

      <Section title="Accent">
        <div className="grid grid-cols-5 gap-2">
          {ACCENTS.map((c) => (
            <Swatch key={c.name} name={c.name} className={c.className} />
          ))}
        </div>
      </Section>

      <Section title="Semantic status">
        <div className="grid grid-cols-4 gap-3">
          {SEMANTIC.map((s) => (
            <div key={s.name} className="flex flex-col gap-2">
              <div className={`flex h-12 items-center justify-center rounded-sm ${s.subtle} ${s.text} text-sm font-medium`}>
                {s.name}
              </div>
              <div className={`h-6 rounded-sm ${s.base}`} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Agent colors">
        <div className="grid grid-cols-8 gap-2">
          {AGENTS.map((c) => (
            <Swatch key={c.name} name={c.name} className={c.className} />
          ))}
        </div>
      </Section>

      <Section title="Type scale" description="Geist for UI, Geist Mono for code and logs.">
        <div className="flex flex-col gap-2">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="flex items-baseline gap-4">
              <span className="w-32 shrink-0 text-xs text-fg-muted">{t.name}</span>
              <span className={`${t.className} text-fg`}>The agent is working on your task</span>
            </div>
          ))}
          <div className="flex items-baseline gap-4">
            <span className="w-32 shrink-0 text-xs text-fg-muted">mono · 13</span>
            <span className="font-mono text-sm text-fg">npm test -- --watch=false</span>
          </div>
        </div>
      </Section>

      <Section title="Spacing" description="4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.">
        <div className="flex flex-col gap-2">
          {SPACING.map((s) => (
            <div key={s.name} className="flex items-center gap-4">
              <span className="w-24 shrink-0 text-xs text-fg-muted">{s.name}</span>
              <span className={`h-3 rounded-sm bg-accent ${s.className}`} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Radius">
        <div className="flex items-center gap-4">
          {RADII.map((r) => (
            <div key={r.name} className="flex flex-col items-center gap-2">
              <div className={`h-16 w-24 border border-border-strong bg-surface ${r.className}`} />
              <span className="text-xs text-fg-muted">{r.name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Elevation" description="Two levels, floating layers only.">
        <div className="flex items-center gap-8 bg-bg-subtle p-8">
          <div className="flex h-20 w-40 items-center justify-center rounded-md border border-border bg-surface text-sm text-fg-muted shadow-raised">
            shadow-raised
          </div>
          <div className="flex h-20 w-40 items-center justify-center rounded-md border border-border bg-surface-raised text-sm text-fg-muted shadow-overlay">
            shadow-overlay
          </div>
        </div>
      </Section>
    </div>
  ),
};
