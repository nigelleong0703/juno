import type { Space, SpaceHostedUpdate, SpaceVisibility } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  CopyField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  SegmentedControl,
  Switch,
} from "@agent-desktop/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useClient, usePlatform } from "../../data/ClientProvider";

/** Who may open the hosted copy, with what each choice means for the owner (BACKEND §5.12, option B). */
const VISIBILITY: { value: SpaceVisibility; label: string; hint: string }[] = [
  { value: "link", label: "Link", hint: "Anyone with the link can open it. It is not listed anywhere." },
  { value: "public", label: "Public", hint: "Anyone with the link can open it, and search engines may index it." },
  { value: "private", label: "Private", hint: "Only you can open it, through Open as me." },
];

/** The reason a sharing request failed: the server's own message for a 409, a plain line otherwise. */
export function sharingErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "HOSTED_UNAVAILABLE") return "Sharing links aren't set up on this server yet";
  if (code === "SPACE_HAS_SERVER_CODE" && error instanceof Error && error.message) return error.message;
  return "Could not update sharing. Try again.";
}

/**
 * Share a Space as a link: publish a copy of the app and its data, change who may open it and whether visitors may
 * write, open it as the owner, publish a new version, or stop sharing. Reads and writes the `["space", id]` query so the
 * card's status and this sheet always show the same `hosted` state.
 */
export function SpaceShareDialog({ space, name, open, onOpenChange }: { space: Space; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useClient();
  const platform = usePlatform();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const hosted = space.hosted;

  const remember = (next: Space["hosted"]) => {
    queryClient.setQueryData<Space>(["space", space.id], (current) => (current ? { ...current, hosted: next } : current));
  };
  const fail = (e: unknown) => setError(sharingErrorMessage(e));

  const publish = useMutation({
    // A republish keeps the link and its access; the first publish takes the default (link, visitors read-only).
    mutationFn: () => client.spaces.publishHosted(space.id, {}),
    onSuccess: (next) => {
      setError(null);
      remember(next);
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (body: SpaceHostedUpdate) => client.spaces.updateHosted(space.id, body),
    onSuccess: (next) => {
      setError(null);
      remember(next);
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: () => client.spaces.revokeHosted(space.id),
    onSuccess: () => {
      setError(null);
      setConfirmStop(false);
      remember(undefined);
    },
    onError: (e) => {
      setConfirmStop(false);
      fail(e);
    },
  });
  const openAsMe = useMutation({
    mutationFn: () => client.spaces.hostedOpenUrl(space.id),
    onSuccess: ({ url }) => {
      setError(null);
      platform.openExternal(url);
    },
    onError: fail,
  });
  const busy = publish.isPending || update.isPending || revoke.isPending || openAsMe.isPending;
  const access = VISIBILITY.find((option) => option.value === hosted?.visibility);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share &ldquo;{name}&rdquo;</DialogTitle>
            <DialogDescription>
              {hosted
                ? "The app and its data are hosted at this link. Publishing again replaces the hosted copy with what is on your computer now."
                : "Publishing copies this app and its data to a link that keeps working when your computer sleeps."}
            </DialogDescription>
          </DialogHeader>

          {hosted ? (
            <div className="flex flex-col gap-5">
              <CopyField label="Link" value={hosted.url} />

              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Who can open it</span>
                <SegmentedControl
                  aria-label="Who can open it"
                  fill
                  disabled={busy}
                  items={VISIBILITY.map(({ value, label }) => ({ value, label }))}
                  value={hosted.visibility}
                  onValueChange={(value) => {
                    const next = VISIBILITY.find((option) => option.value === value);
                    if (next && next.value !== hosted.visibility) update.mutate({ visibility: next.value });
                  }}
                />
                {access ? <p className="text-xs text-fg-subtle">{access.hint}</p> : null}
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="space-visitor-writes">Visitors can change data</Label>
                  <p className="text-xs text-fg-subtle">Off: people without your sign-in can only read the data.</p>
                </div>
                <Switch
                  id="space-visitor-writes"
                  checked={hosted.visitorWrites}
                  disabled={busy}
                  onCheckedChange={(checked) => update.mutate({ visitorWrites: checked })}
                />
              </div>
            </div>
          ) : null}

          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

          <DialogFooter className="flex-wrap sm:justify-between">
            {hosted ? (
              <>
                <Button variant="ghost" className="text-danger" disabled={busy} onClick={() => setConfirmStop(true)}>
                  Stop sharing
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={busy} onClick={() => openAsMe.mutate()}>
                    {openAsMe.isPending ? "Opening…" : "Open as me"}
                  </Button>
                  <Button disabled={busy} onClick={() => publish.mutate()}>
                    {publish.isPending ? "Publishing…" : "Publish new version"}
                  </Button>
                </div>
              </>
            ) : (
              <Button disabled={busy} onClick={() => publish.mutate()}>
                {publish.isPending ? "Sharing…" : "Share link"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogTitle>Stop sharing this app?</AlertDialogTitle>
          <AlertDialogDescription>The link stops working and its hosted data is deleted. Publishing again creates a new link.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Stop sharing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
