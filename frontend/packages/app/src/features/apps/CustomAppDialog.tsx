import type { ProbeCustomAppResponse } from "@agent-desktop/client";
import type { HttpError } from "@agent-desktop/client/http";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  ListRow,
  SegmentedControl,
} from "@agent-desktop/ui";
import { useState } from "react";
import { useInstallApp, useOpenInstall, useProbeCustomApp } from "../../data/apps";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";

type Marks = Record<string, "read" | "change">;

/** The read / change mark of each probed tool as suggested (a tool nothing marked is a change). */
const suggestedMarks = (probe: ProbeCustomAppResponse): Marks => Object.fromEntries((probe.tools ?? []).map((tool) => [tool.name, tool.suggested]));

/** The step after the server was checked: how it signs people in and its tools, each marked Read or Change; a row switches its mark. */
function ConfirmStep({ probe, marks, onFlip }: { probe: ProbeCustomAppResponse; marks: Marks; onFlip: (name: string) => void }) {
  const tools = probe.tools ?? [];
  const capped = useCapped(tools, 8);
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">{probe.auth === "oauth" ? t("apps.custom.loginOauth", { issuer: probe.oauth?.issuer ?? probe.url }) : t("apps.custom.loginNone")}</p>
      {probe.auth === "oauth" ? <p className="text-sm text-fg-muted">{t("apps.custom.oauthTools")}</p> : null}
      {tools.length > 0 ? (
        <section aria-label={t("apps.custom.tools")} className="flex flex-col gap-1">
          <p className="text-sm text-fg-muted">{t("apps.custom.confirmHint")}</p>
          <ul className="flex flex-col">
            {capped.shown.map((tool) => {
              const change = marks[tool.name] !== "read";
              return (
                <li key={tool.name}>
                  <ListRow
                    dense
                    onClick={() => onFlip(tool.name)}
                    title={tool.title || tool.name}
                    trailing={<span className={change ? "text-sm text-warning" : "text-sm text-fg-subtle"}>{change ? t("apps.changes") : t("apps.read")}</span>}
                  />
                </li>
              );
            })}
          </ul>
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Add a custom app: any MCP server by address or command. An address is checked first (`POST /v1/apps/custom/probe`): the person sees how the
 * server signs in and its tools with a Read or Change mark each, flips any, and confirms (`POST /v1/apps/custom/install` with `confirm`). A command needs no check.
 */
export function CustomAppDialog({ onClose }: { onClose: () => void }) {
  const install = useInstallApp();
  const probeCall = useProbeCustomApp();
  const open = useOpenInstall();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"url" | "command">("url");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [probe, setProbe] = useState<ProbeCustomAppResponse | null>(null);
  const [marks, setMarks] = useState<Marks>({});
  const [error, setError] = useState<string | null>(null);

  const target = mode === "url" ? url.trim() : command.trim();
  const message = (e: unknown) => (e instanceof Error && e.message ? e.message : t("apps.addFailed"));
  const busy = install.isPending || probeCall.isPending;

  /** Look at the server; a usable one moves to the confirm step, an unusable one says why and the form stays. */
  const check = (notice?: string) => {
    setError(null);
    probeCall.mutate(target, {
      onSuccess: (result) => {
        if (!result.usable) {
          setProbe(null);
          setError(result.problem ?? t("apps.addFailed"));
          return;
        }
        setProbe(result);
        setMarks(suggestedMarks(result));
        if (notice) setError(notice);
      },
      onError: (e) => {
        setProbe(null);
        setError(message(e));
      },
    });
  };

  const add = () => {
    setError(null);
    const args = argsText.split(/\s+/).filter((part) => part.length > 0);
    const input =
      mode === "url"
        ? { name: name.trim(), transport: "http" as const, url: target, confirm: { auth: probe?.auth === "oauth" ? ("oauth" as const) : ("none" as const), tools: marks } }
        : { name: name.trim(), transport: "stdio" as const, command: target, ...(args.length > 0 ? { args } : {}) };
    install.mutate(
      { appId: "custom", input },
      {
        onSuccess: (response) => {
          open(response, name.trim());
          onClose();
        },
        onError: (e) => {
          const code = (e as Partial<HttpError>).code;
          if (code === "CUSTOM_PROBE_REQUIRED" || code === "CUSTOM_PROBE_CHANGED") check(code === "CUSTOM_PROBE_CHANGED" ? t("apps.custom.changed") : undefined);
          else {
            if (code === "CUSTOM_NOT_USABLE") setProbe(null);
            setError(message(e));
          }
        },
      },
    );
  };

  const flip = (tool: string) => setMarks((current) => ({ ...current, [tool]: current[tool] === "read" ? "change" : "read" }));
  const confirming = mode === "url" && probe !== null;
  const ready = name.trim() !== "" && target !== "" && !busy;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("apps.custom.title")}</DialogTitle>
          <DialogDescription>{t("apps.custom.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            if (mode === "url" && !confirming) check();
            else add();
          }}
        >
          {confirming ? (
            <ConfirmStep probe={probe} marks={marks} onFlip={flip} />
          ) : (
            <>
              <FormField label={t("apps.custom.name")}>
                <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Linear" />
              </FormField>
              <SegmentedControl
                fill
                aria-label={t("apps.custom.connectWith")}
                value={mode}
                onValueChange={(value) => setMode(value === "command" ? "command" : "url")}
                items={[
                  { value: "url", label: t("apps.custom.url") },
                  { value: "command", label: t("apps.custom.command") },
                ]}
              />
              {mode === "url" ? (
                <FormField label={t("apps.custom.serverUrl")}>
                  <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" className="font-mono" />
                </FormField>
              ) : (
                <>
                  <FormField label={t("apps.custom.executable")}>
                    <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" className="font-mono" />
                  </FormField>
                  <FormField label={`${t("apps.custom.args")} (${t("apps.optional")})`}>
                    <Input value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder="-y @scope/mcp-server" className="font-mono" />
                  </FormField>
                </>
              )}
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={
                confirming
                  ? () => {
                      setProbe(null);
                      setError(null);
                    }
                  : onClose
              }
            >
              {confirming ? t("apps.custom.back") : t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!ready}>
              {mode === "url" && !confirming ? (probeCall.isPending ? t("apps.custom.checking") : t("apps.custom.check")) : t("apps.custom.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
