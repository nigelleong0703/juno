import type { LibraryItem } from "@agent-desktop/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { decodePreview, previewKind, type ArtifactPreview } from "../conversation/artifactPreview";

export function useFilePreview(item: LibraryItem | null) {
  const client = useClient();
  const query = useQuery({
    queryKey: ["artifact-preview", item?.id, item?.updatedAt],
    queryFn: async () => {
      if (!item) throw new Error("File unavailable");
      return decodePreview(item, await client.library.download(item.id));
    },
    enabled: Boolean(item && previewKind(item)),
    retry: false,
    staleTime: Infinity,
  });
  const preview = query.data;
  const [objectUrlState, setObjectUrlState] = useState<{ preview: ArtifactPreview; url: string } | null>(null);

  useEffect(() => {
    if (!preview || preview.kind === "text" || preview.kind === "table" || preview.kind === "document" || preview.kind === "slides" || preview.kind === "archive" || preview.kind === "pdf") {
      setObjectUrlState(null);
      return;
    }
    const url = URL.createObjectURL(preview.blob);
    setObjectUrlState({ preview, url });
    return () => URL.revokeObjectURL(url);
  }, [preview]);

  const objectUrl = objectUrlState && objectUrlState.preview === preview ? objectUrlState.url : null;
  return { ...query, preview, objectUrl };
}
