import type { Profile, PutProfileInput } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** The account profile: a flat list of key/value details. Not secret; the agents fill it into pages themselves. */
export function useProfile() {
  const client = useClient();
  return useQuery({ queryKey: qk.profile(), queryFn: () => client.profile.get() });
}

/** `PUT /v1/profile` replaces the whole list, so every edit sends all the entries. */
export function useSaveProfile() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutProfileInput) => client.profile.put(body),
    onSuccess: (saved: Profile) => qc.setQueryData(qk.profile(), saved),
  });
}
