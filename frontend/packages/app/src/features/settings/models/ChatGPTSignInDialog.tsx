import type { ChatGPTLoginStartResult, ModelProvider } from "@agent-desktop/client";
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
} from "@agent-desktop/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../data/ClientProvider";
import {
  errorCode,
  useCancelChatGPTLogin,
  useChatGPTLoginStatus,
  useCompleteChatGPTLogin,
  useStartChatGPTLogin,
} from "../../../data/model-providers";
import { t } from "../../../lib/i18n";

type Notice = { tone: "error" | "restarted"; text: string };

/**
 * ChatGPT subscription sign-in as two steps: open the sign-in page, then either wait (the desktop
 * engine catches the browser's redirect itself, `automatic`) or paste the address the browser ended
 * on (a localhost page that will not load, which the copy says up front). The paste stays available
 * under the waiting line. The backend consumes a login on its first complete attempt, so any 4xx from
 * complete starts a fresh login instead of letting the user retry the paste against a dead one.
 */
export function ChatGPTSignInDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (provider: ModelProvider) => void;
}) {
  const { openExternal } = usePlatform();
  const start = useStartChatGPTLogin();
  const complete = useCompleteChatGPTLogin();
  const [login, setLogin] = useState<ChatGPTLoginStartResult | null>(null);
  const [paste, setPaste] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pasting, setPasting] = useState(false);
  const cancel = useCancelChatGPTLogin();
  const status = useChatGPTLoginStatus(login?.automatic ? login.loginId : null);
  const outcome = status.data;

  // The engine finished (or refused) the login on its own: carry on, or say why not and offer a fresh start.
  useEffect(() => {
    if (outcome?.status === "connected") {
      onConnected(outcome.provider);
      onClose();
    } else if (outcome?.status === "failed" && outcome.error.code !== "CANCELLED") {
      const key = `models.chatgpt.error.${outcome.error.code}`;
      setLogin(null);
      setPaste("");
      setPasting(false);
      setNotice({ tone: "error", text: t(key) === key ? t("models.error.generic") : t(key) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the outcome only; the handlers are stable enough
  }, [outcome]);

  const close = () => {
    if (login !== null) cancel.mutate(login.loginId);
    onClose();
  };

  const begin = async (openNow: boolean): Promise<boolean> => {
    try {
      const started = await start.mutateAsync();
      setLogin(started);
      if (openNow) openExternal(started.authorizationUrl);
      return true;
    } catch {
      setNotice({ tone: "error", text: t("models.chatgpt.startFailed") });
      return false;
    }
  };

  const connect = async () => {
    if (login === null) return;
    setNotice(null);
    try {
      const provider = await complete.mutateAsync({ loginId: login.loginId, callbackUrl: paste.trim() });
      onConnected(provider);
      onClose();
    } catch (error) {
      const { status, code } = errorCode(error);
      setPaste("");
      // OpenAI wants a second authorization with the client it issued: continue there, in the same dialog.
      const fields = (error as { fields?: Record<string, string> }).fields;
      if (code === "REAUTHORIZE" && fields?.loginId && fields.authorizationUrl) {
        setLogin({ loginId: fields.loginId, authorizationUrl: fields.authorizationUrl, automatic: fields.automatic === "true" });
        openExternal(fields.authorizationUrl);
        setNotice({ tone: "restarted", text: t("models.chatgpt.reauthorize") });
        return;
      }
      if (status === 400 || status === 404) {
        const reasonKey = `models.chatgpt.error.${code}`;
        const reason = code === undefined || t(reasonKey) === reasonKey ? t("models.error.generic") : t(reasonKey);
        setLogin(null);
        setPasting(false);
        if (login.automatic) setNotice({ tone: "error", text: reason });
        else if (await begin(false)) setNotice({ tone: "restarted", text: t("models.chatgpt.restarted", { reason }) });
      } else {
        setNotice({ tone: "error", text: status !== undefined && status >= 500 ? t("models.error.server") : t("models.error.generic") });
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("models.chatgpt.title")}</DialogTitle>
          <DialogDescription>
            {login === null ? t("models.chatgpt.step1") : login.automatic ? t("models.chatgpt.stepAuto") : t("models.chatgpt.step2")}
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <p role="alert" className={notice.tone === "error" ? "text-sm text-danger" : "text-sm text-warning"}>
            {notice.text}
          </p>
        )}
        {login === null ? (
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              {t("models.cancel")}
            </Button>
            <Button variant="primary" disabled={start.isPending} onClick={() => void begin(true)}>
              {t("models.chatgpt.open")}
            </Button>
          </DialogFooter>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <div>
              <Button variant="secondary" size="sm" type="button" onClick={() => openExternal(login.authorizationUrl)}>
                {t("models.chatgpt.reopen")}
              </Button>
              <p className="mt-1.5 text-xs text-fg-subtle">{t("models.chatgpt.valid")}</p>
            </div>
            {login.automatic && (
              <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
                <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                {t("models.chatgpt.waiting")}
              </p>
            )}
            {login.automatic && !pasting && (
              <button
                type="button"
                className="self-start text-xs text-fg-subtle underline underline-offset-2 hover:text-fg"
                onClick={() => setPasting(true)}
              >
                {t("models.chatgpt.pasteInstead")}
              </button>
            )}
            {(!login.automatic || pasting) && (
              <>
                {login.automatic && <p className="text-xs text-fg-subtle">{t("models.chatgpt.pasteHint")}</p>}
            <FormField label={t("models.chatgpt.paste")}>
              <Input
                autoFocus={!login.automatic}
                autoComplete="off"
                spellCheck={false}
                value={paste}
                placeholder={t("models.chatgpt.placeholder")}
                onChange={(event) => setPaste(event.currentTarget.value)}
              />
            </FormField>
              </>
            )}
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={close}>
                {t("models.cancel")}
              </Button>
              {(!login.automatic || pasting) && (
                <Button variant="primary" type="submit" disabled={paste.trim() === "" || complete.isPending}>
                  {t("models.chatgpt.connect")}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
