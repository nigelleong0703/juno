import type { AccountView, PersonRelationView, PersonView, PossibleMatch } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  toast,
} from "@agent-desktop/ui";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { Fragment, useState } from "react";
import { useNavigate } from "react-router";
import { initialsOf } from "../../auth/account";
import { useAuthIdentity } from "../../auth/AuthContext";
import { AccountAvatar } from "../../components/agent/AccountAvatar";
import { BrandIcon } from "../../components/BrandIcon";
import { channelPlatformName } from "../../components/channel/platforms";
import { PageAction } from "../../components/page/PageFrame";
import { t } from "../../lib/i18n";
import {
  isMemoryUnavailable,
  isUnavailable,
  useConfirmRelation,
  useDeleteRelation,
  useLinkMatch,
  usePeople,
  usePossibleMatches,
  useRenamePerson,
  useUnlinkAccount,
} from "../../data/people";
import { ShowMore, useCapped } from "../agents/card/parts";
import { accountHandle, accountLabel, accountPhrase, relationPhrase, sentenceCase } from "./personProse";
import { TeamComingSoon } from "./TeamComingSoon";

/** People before "Show more". */
const PEOPLE_LIMIT = 20;
/** Phrases of one sentence (accounts, relations) before "and N more". */
const PHRASE_LIMIT = 5;
/** Relations on a list entry's muted line. */
const LINE_RELATIONS = 2;

/** The route's id for the possible-matches screen (`/team/people/matches`), as Memory has `review` and `search`. */
export const MATCHES_ID = "matches";

/** Memory's dotted-underlined phrase. */
const PHRASE =
  "inline cursor-pointer text-left underline decoration-fg/35 decoration-dotted underline-offset-[5px] hover:decoration-fg/60 focus-ring";
/** Memory's paragraph type. */
const PROSE = "text-[21px] leading-[1.45] tracking-[-0.01em] text-fg";

const onError = () => toast.error(t("common.error"));

/** The name to show for a person: the owner's own person is the signed-in user (the name Today greets), not the stored "Owner". */
export function usePersonName(): (person: Pick<PersonView, "name" | "isOwner">) => string {
  const identity = useAuthIdentity();
  const own = identity?.user.name;
  return (person) => (person.isOwner && own ? own : person.name);
}

/** The platforms of a person's accounts, each once, in the order they were linked. */
function platformsOf(person: PersonView): string[] {
  return [...new Set(person.accounts.map((account) => account.platform))];
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * People (Team; No boxes, 2026-10-27): the people the agents know, in Memory's language. The list is one entry per person
 * (initials avatar, the name, one muted line of relations and platform icons), separated by whitespace; a line "N possible
 * matches ›" with an orange dot opens the suggested accounts (`/team/people/matches`). A person's page is prose: the accounts
 * they chat from and their relations are dotted-underlined phrases that open a sheet (Unlink after a confirm; Confirm and
 * Remove). Rename is in the top bar's menu (`PersonMenu`). Every change shows at once and is put back if the server refuses
 * it. A 404 means the route is not there (Coming soon). `detailId` is the person the route names, or `matches`.
 */
export function PeopleSegment({ detailId }: { detailId?: string | undefined }) {
  const people = usePeople();
  const matches = usePossibleMatches(people.isSuccess);
  if (isUnavailable(people.error)) return <TeamComingSoon />;
  if (isMemoryUnavailable(people.error)) return <p className="px-1 text-sm text-fg-muted">{t("team.unavailable")}</p>;
  if (people.isLoading) return <LoadingState label={t("common.loading")} />;
  if (people.isError) return <ErrorState title={t("common.error")} onRetry={() => void people.refetch()} />;
  const items = people.data?.items ?? [];
  const suggested = matches.data?.items ?? [];
  if (detailId === MATCHES_ID) return <MatchesList matches={suggested} />;
  if (detailId) return <PersonDetail person={items.find((person) => person.id === detailId)} />;
  return <PeopleList items={items} matches={suggested} />;
}

function PeopleList({ items, matches }: { items: PersonView[]; matches: PossibleMatch[] }) {
  const navigate = useNavigate();
  const capped = useCapped(items, PEOPLE_LIMIT);
  return (
    <>
      {matches.length > 0 ? (
        <button
          type="button"
          onClick={() => navigate(`/team/people/${MATCHES_ID}`)}
          className="flex items-center gap-2 self-start py-1.5 text-[15px] text-fg focus-ring"
        >
          <span aria-hidden="true" className="size-[7px] rounded-full bg-warning" />
          {t(matches.length === 1 ? "team.possibleMatchOne" : "team.possibleMatchMany", { count: matches.length })}
          <ChevronRight className="size-3 text-fg-subtle" />
        </button>
      ) : null}
      {items.length === 0 ? <p className="px-1 text-sm text-fg-muted">{t("team.peopleEmpty")}</p> : null}
      <ul aria-label={t("team.people")} className="flex flex-col gap-6 pt-1">
        {capped.shown.map((person) => (
          <li key={person.id}>
            <PersonEntry person={person} onOpen={() => navigate(`/team/people/${person.id}`)} />
          </li>
        ))}
      </ul>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </>
  );
}

/** One person: the initials avatar, the name large, then one muted line: their relations, then their platforms as small icons. */
function PersonEntry({ person, onOpen }: { person: PersonView; onOpen: () => void }) {
  const nameOf = usePersonName();
  const name = nameOf(person);
  const relations = person.relations.slice(0, LINE_RELATIONS).map((relation) => relationPhrase(relation));
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3.5 text-left focus-ring">
      <AccountAvatar initials={initialsOf(name) || "?"} size={44} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-xl font-semibold tracking-[-0.01em] text-fg">{name}</span>
          {person.isOwner ? <span className="shrink-0 text-sm text-fg-subtle">{t("team.you")}</span> : null}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[15px] text-fg-muted">
          {relations.length > 0 ? <span className="truncate">{sentenceCase(relations.join(", "))}</span> : null}
          <span className="flex shrink-0 items-center gap-1">
            {platformsOf(person).map((platform) => (
              <span key={platform} title={channelPlatformName(platform)} className="flex">
                <BrandIcon id={platform} className="size-4" />
              </span>
            ))}
          </span>
        </span>
      </span>
    </button>
  );
}

/** The suggested accounts, one line each: which platform and account it is and who it might be; Link asks first. */
function MatchesList({ matches }: { matches: PossibleMatch[] }) {
  if (matches.length === 0) return <EmptyState title={t("team.matchesEmpty")} />;
  return (
    <ul aria-label={t("team.possibleMatches")} className="flex flex-col gap-5 pt-1">
      {matches.map((match) => (
        <li key={`${match.account.id}-${match.person.id}`}>
          <MatchLine match={match} />
        </li>
      ))}
    </ul>
  );
}

/** A suggested account; linking it is the owner's decision, so it asks first. */
function MatchLine({ match }: { match: PossibleMatch }) {
  const link = useLinkMatch();
  const [asking, setAsking] = useState(false);
  const accountName = match.account.name ?? channelPlatformName(match.account.platform);
  return (
    <div className="flex items-center gap-3">
      <BrandIcon id={match.account.platform} className="size-6" />
      <span className="min-w-0 flex-1 text-[17px] leading-snug text-fg">
        {t("team.matchLine", { platform: channelPlatformName(match.account.platform), account: accountName, name: match.person.name })}
      </span>
      <Button variant="secondary" size="sm" className="rounded-full" disabled={link.isPending} onClick={() => setAsking(true)}>
        {t("team.link")}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("team.linkTitle", { account: accountName, name: match.person.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("team.linkBody", { name: match.person.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => link.mutate(match, { onError })}>{t("team.link")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One person's page: the large initials avatar and name, then prose. "Reaches your team as @AlexH on Discord and @big on
 * Telegram." (each account a phrase that opens its sheet) and "Juno's friend and Sol's colleague." (each relation a phrase
 * that opens its sheet). With neither, one muted line.
 */
function PersonDetail({ person }: { person: PersonView | undefined }) {
  const nameOf = usePersonName();
  const [openAccountId, setOpenAccountId] = useState<string | undefined>(undefined);
  const [openRelationId, setOpenRelationId] = useState<string | undefined>(undefined);
  if (!person) return <EmptyState title={t("team.personGone")} />;
  const name = nameOf(person);
  const account = person.accounts.find((candidate) => candidate.id === openAccountId);
  const relation = person.relations.find((candidate) => candidate.id === openRelationId);
  const nothing = person.accounts.length === 0 && person.relations.length === 0;
  return (
    <>
      <div className="flex flex-col items-start gap-3 pt-2">
        <AccountAvatar initials={initialsOf(name) || "?"} size={88} />
        <h2 className="flex min-w-0 max-w-full items-baseline gap-2">
          <span className="truncate text-[30px] font-bold leading-tight tracking-[-0.02em] text-fg">{name}</span>
          {person.isOwner ? <span className="shrink-0 text-base text-fg-subtle">{t("team.you")}</span> : null}
        </h2>
      </div>
      <div className="flex flex-col gap-5 pt-1">
        {person.accounts.length > 0 ? (
          <p className={PROSE}>
            {t(person.isOwner ? "team.reachesAsYou" : "team.reachesAs")}{" "}
            <Phrases items={person.accounts} text={accountPhrase} unconfirmed={() => false} onOpen={(item) => setOpenAccountId(item.id)} />.
          </p>
        ) : null}
        {person.relations.length > 0 ? (
          <p className={PROSE}>
            {person.isOwner ? `${t("team.youAre")} ` : null}
            <Phrases
              items={person.relations}
              text={(item) => relationPhrase(item, person.isOwner)}
              unconfirmed={(item) => !item.confirmed}
              capitalise={!person.isOwner}
              onOpen={(item) => setOpenRelationId(item.id)}
            />
            .
          </p>
        ) : null}
        {nothing ? <p className="text-[15px] text-fg-muted">{t("team.personNothing")}</p> : null}
      </div>
      {account ? <AccountSheet key={account.id} account={account} person={person} name={name} onClose={() => setOpenAccountId(undefined)} /> : null}
      {relation ? <RelationSheet key={relation.id} relation={relation} person={person} you={person.isOwner} onClose={() => setOpenRelationId(undefined)} /> : null}
    </>
  );
}

/**
 * Phrases joined as part of a sentence: "a, b and c". Each is a dotted-underlined button; a phrase the owner has not confirmed
 * is italic. Past `PHRASE_LIMIT` the rest folds into "and N more", which expands them.
 */
function Phrases<T extends { id: string }>({
  items,
  text,
  unconfirmed,
  capitalise = false,
  onOpen,
}: {
  items: readonly T[];
  text: (item: T) => string;
  unconfirmed: (item: T) => boolean;
  capitalise?: boolean;
  onOpen: (item: T) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, PHRASE_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <>
      {shown.map((item, index) => {
        const label = text(item);
        const separator = index === shown.length - 1 ? "" : index === shown.length - 2 && hidden === 0 ? ` ${t("team.and")} ` : ", ";
        return (
          <Fragment key={item.id}>
            <button type="button" onClick={() => onOpen(item)} className={unconfirmed(item) ? `${PHRASE} italic` : PHRASE}>
              {capitalise && index === 0 ? sentenceCase(label) : label}
            </button>
            {separator}
          </Fragment>
        );
      })}
      {hidden > 0 ? (
        <>
          {" "}
          <button type="button" onClick={() => setAll(true)} className="inline cursor-pointer text-fg-muted focus-ring">
            {t("team.andMore", { count: hidden })}
          </button>
        </>
      ) : null}
    </>
  );
}

/** One account: its platform icon and handle, where it was last seen, and Unlink (after a confirm). */
function AccountSheet({ account, person, name, onClose }: { account: AccountView; person: PersonView; name: string; onClose: () => void }) {
  const unlink = useUnlinkAccount();
  const [asking, setAsking] = useState(false);
  const platform = channelPlatformName(account.platform);
  const when = whenText(account.lastSeen);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{platform}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <BrandIcon id={account.platform} className="size-9" />
          <div className="min-w-0">
            <p className="truncate text-lg font-medium text-fg">{accountHandle(account) ?? platform}</p>
            <p className="text-sm text-fg-muted">{account.lastChat ? t("team.seenIn", { chat: account.lastChat, when }) : t("team.seen", { when })}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={() => setAsking(true)}>
            {t("team.unlink")}
          </Button>
        </DialogFooter>
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("team.unlinkTitle", { account: accountLabel(account) })}</AlertDialogTitle>
              <AlertDialogDescription>{t("team.unlinkBody", { account: accountLabel(account), name })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  unlink.mutate({ personId: person.id, accountId: account.id }, { onError });
                  onClose();
                }}
              >
                {t("team.unlink")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

/** One relation: how it reads, whether the owner has confirmed it, Confirm (when not) and Remove. */
function RelationSheet({ relation, person, you, onClose }: { relation: PersonRelationView; person: PersonView; you: boolean; onClose: () => void }) {
  const confirm = useConfirmRelation();
  const remove = useDeleteRelation();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{you ? `${t("team.youAre")} ${relationPhrase(relation, true)}` : sentenceCase(relationPhrase(relation))}</DialogTitle>
          <DialogDescription>{relation.confirmed ? t("team.relationSaid") : t("team.relationGuess")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              remove.mutate({ personId: person.id, relationId: relation.id }, { onError });
              onClose();
            }}
          >
            {t("common.remove")}
          </Button>
          {relation.confirmed ? null : (
            <Button
              variant="primary"
              onClick={() => {
                confirm.mutate({ personId: person.id, relationId: relation.id }, { onError });
                onClose();
              }}
            >
              {t("team.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The top bar's "…" on a person's page: Rename (a dialog with the name field; the new name shows at once). */
export function PersonMenu({ personId }: { personId: string }) {
  const people = usePeople();
  const [renaming, setRenaming] = useState(false);
  const person = people.data?.items.find((candidate) => candidate.id === personId);
  if (!person) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PageAction icon={MoreHorizontal} label={t("team.personMore")} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>{t("team.rename")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? <RenameDialog person={person} onClose={() => setRenaming(false)} /> : null}
    </>
  );
}

/** Rename a person; the new name shows at once. */
function RenameDialog({ person, onClose }: { person: PersonView; onClose: () => void }) {
  const [name, setName] = useState(person.name);
  const rename = useRenamePerson();
  const submit = () => {
    const next = name.trim();
    if (next && next !== person.name) rename.mutate({ personId: person.id, name: next }, { onError });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("team.renameTitle")}</DialogTitle>
          <DialogDescription>{t("team.renameHint")}</DialogDescription>
        </DialogHeader>
        <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label={t("team.rename")} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
