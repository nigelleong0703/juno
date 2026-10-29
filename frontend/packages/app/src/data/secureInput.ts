import type { Request, SecureInputResult } from "@agent-desktop/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useClient } from "./ClientProvider";
import { sealSecureValues } from "../lib/secureInputCrypto";
import { qk } from "./keys";

/**
 * Submit a secure-input form. The values are encrypted to the computer's key before they leave this module. Deliberately NOT a react-query mutation: a mutation keeps its
 * `variables` in the mutation cache, and these values are secrets. The values go from the caller
 * straight into the request body; only the returned request (no values) reaches a cache.
 */
export function useSecureInputSubmit(request: Request) {
  const client = useClient();
  const qc = useQueryClient();
  return useCallback(
    async (values: Record<string, string>): Promise<SecureInputResult> => {
      if (request.payload.kind !== "secure_input") throw new Error("not a secure input request");
      const { encryption, fields } = request.payload;
      if (!encryption) throw Object.assign(new Error("This request is from an older computer"), { code: "ENCRYPTION_UNAVAILABLE" });
      const sealed = await sealSecureValues(encryption, request.id, fields, values);
      const result = await client.requests.submitSecureInput(request.id, { fields: sealed });
      qc.setQueryData<Request>(qk.request(request.id), result.request);
      void qc.invalidateQueries({ queryKey: ["requests"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
      return result;
    },
    [client, qc, request.id],
  );
}
