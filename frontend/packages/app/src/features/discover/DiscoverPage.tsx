import type { Skill } from "@agent-desktop/client";
import { Button, EmptyState, LoadingState, ScrollArea, SearchField, SegmentedControl, toast } from "@agent-desktop/ui";
import { useState } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { PageFrame, SECTION_LABEL } from "../../components/page/PageFrame";
import { useSkillsPage } from "../../data/queries";
import { CHARACTER_TINT, defaultCharacter } from "../../lib/avatars";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { TEMPLATES, type RoleTemplate } from "../new-agent/NewAgentTemplateDialog";
import { useCreateAgentAndOpen } from "../new-agent/useCreateAgentAndOpen";
import { skillDescription, skillName } from "../skills/skillModel";
import { AddSkillDialog } from "./AddSkillDialog";

/** Rows per list before "Show more". */
const LIST_LIMIT = 6;

type Category = "all" | "agents" | "skills";

/** A template's character, the one an agent with the template's name as its id gets (the iPhone Discover does the same). */
function templateCharacter(template: RoleTemplate) {
  return defaultCharacter(template.name);
}

/** The template's character on a soft wash of its tint. */
function TemplateAvatar({ template, size }: { template: RoleTemplate; size: number }) {
  const tint = CHARACTER_TINT[templateCharacter(template)];
  return (
    <span
      aria-hidden="true"
      style={{ backgroundImage: `radial-gradient(circle, ${tint}59, ${tint}00 70%)`, width: size + 16, height: size + 16 }}
      className="flex shrink-0 items-center justify-center rounded-full"
    >
      <AgentAvatar agentId={template.name} size={size} />
    </span>
  );
}

/** Whether `text` (lower case, trimmed) is in one of the fields; an empty text matches everything. */
function matches(text: string, ...fields: (string | undefined)[]): boolean {
  return text === "" || fields.some((field) => (field ?? "").toLowerCase().includes(text));
}

/**
 * Discover (owner-approved 2026-10-26, first version, our own content): a search field, one featured agent template, the
 * categories and a list of what can be installed (the featured one is not listed again under it). "Install" creates an
 * agent from a template through the normal create flow and opens its chat. "Add" puts a skill on an agent the owner chooses.
 * Only persona, skills and workflows are shared; memory, people and accounts never are, and the footer says so.
 */
export function DiscoverPage() {
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const createAgent = useCreateAgentAndOpen();
  const skills = useSkillsPage();
  const text = query.trim().toLowerCase();
  const skillRows = (skills.data?.pages.flatMap((page) => page.items) ?? []).filter((skill) => matches(text, skillName(skill), skillDescription(skill)));
  const showAgents = category === "all" || category === "agents";
  const showSkills = category === "all" || category === "skills";
  // The featured card is the first template; while searching it is just one of the results.
  const featured = category === "all" && text === "" ? TEMPLATES[0] : undefined;
  const templates = TEMPLATES.filter((template) => template !== featured && matches(text, template.name, template.title, template.blurb));

  const install = (template: RoleTemplate) =>
    createAgent.mutate(
      { name: template.name, title: template.title, personality: template.personality, instructions: template.instructions },
      { onError: () => toast.error(t("common.error")) },
    );

  return (
    <PageFrame title={t("discover.title")}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pb-10">
          <SearchField value={query} onValueChange={setQuery} placeholder={t("discover.search")} />
          {featured ? (
            <section
              aria-label={t("discover.featured")}
              style={{ backgroundImage: `linear-gradient(225deg, ${CHARACTER_TINT[templateCharacter(featured)]}2e, transparent 70%)` }}
              className="flex items-start gap-4 rounded-3xl bg-muted/70 p-5"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className={SECTION_LABEL}>{t("discover.featured")}</span>
                <span className="text-xl font-semibold text-fg">
                  {featured.name} · {featured.title}
                </span>
                <span className="text-sm text-fg-muted">{featured.blurb}</span>
                <Button size="sm" className="mt-1 self-start rounded-full" disabled={createAgent.isPending} onClick={() => install(featured)}>
                  {t("discover.install")}
                </Button>
              </div>
              <TemplateAvatar template={featured} size={72} />
            </section>
          ) : null}

          <SegmentedControl
            aria-label={t("discover.title")}
            className="self-center"
            value={category}
            onValueChange={(value) => setCategory(value as Category)}
            items={[
              { value: "all", label: t("discover.all") },
              { value: "agents", label: t("discover.agents") },
              { value: "skills", label: t("discover.skills") },
            ]}
          />

          {showAgents && (templates.length > 0 || text === "") ? <TemplateList templates={templates} busy={createAgent.isPending} onInstall={install} /> : null}
          {showSkills ? (
            skills.isLoading ? (
              <LoadingState label={t("common.loading")} />
            ) : (
              <SkillList skills={skillRows} searching={text !== ""} />
            )
          ) : null}

          <p className="px-1 text-xs text-fg-muted">{t("discover.footer")}</p>
        </div>
      </ScrollArea>
    </PageFrame>
  );
}

function TemplateList({ templates, busy, onInstall }: { templates: RoleTemplate[]; busy: boolean; onInstall: (template: RoleTemplate) => void }) {
  const capped = useCapped(templates, LIST_LIMIT);
  return (
    <section aria-label={t("discover.agents")} className="flex flex-col gap-2">
      {capped.shown.map((template) => (
        <div key={template.slug} className="flex items-center gap-3 rounded-2xl bg-muted/70 p-2.5 pr-3">
          <TemplateAvatar template={template} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-fg">
              {template.name} · {template.title}
            </span>
            <span className="block truncate text-[13px] text-fg-muted">{template.blurb}</span>
          </span>
          <Button size="xs" className="rounded-full" disabled={busy} onClick={() => onInstall(template)}>
            {t("discover.install")}
          </Button>
        </div>
      ))}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}

function SkillList({ skills, searching }: { skills: Skill[]; searching: boolean }) {
  const capped = useCapped(skills, LIST_LIMIT);
  if (skills.length === 0) return <EmptyState title={searching ? t("discover.noMatch") : t("discover.empty")} />;
  return (
    <section aria-label={t("discover.skills")} className="flex flex-col gap-2">
      {capped.shown.map((skill) => (
        <SkillRow key={skill.id} skill={skill} />
      ))}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-muted/70 p-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg">{skillName(skill)}</span>
        <span className="block truncate text-[13px] text-fg-muted">{skillDescription(skill)}</span>
      </span>
      <Button variant="ghost" size="xs" className="rounded-full" onClick={() => setAdding(true)}>
        {t("discover.add")}
      </Button>
      {adding ? <AddSkillDialog skill={skill} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
