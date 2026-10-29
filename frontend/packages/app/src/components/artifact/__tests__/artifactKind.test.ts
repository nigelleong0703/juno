import type { LibraryItem } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { filterLibrary, thumbnailSource, viewerKind } from "../artifactKind";

const stamp = "2026-10-27T00:00:00Z";
function item(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    name: `${id}.md`,
    kind: "document",
    mimeType: "text/markdown",
    sizeBytes: 1,
    shared: "private",
    source: "agent",
    tags: [],
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

const page = item("page", { name: "trip.html", render: "html", mimeType: "text/html", version: 1, versions: [{ version: 1, fileRef: "f", sizeBytes: 1, mimeType: "text/html", createdAt: stamp, thumbnailRef: "t" }] });
const file = item("file");
const picture = item("picture", { name: "poster.png", kind: "image", mimeType: "image/png" });
const app = item("app", { name: "Budget", render: "app", spaceId: "sp-budget" });
const shared = item("shared", { name: "Recipes", render: "app", spaceId: "sp-recipes" });
const all = [page, file, picture, app, shared];
const hosted = new Set(["sp-recipes"]);

describe("Library categories", () => {
  it("splits pages, files and spaces so that each item sits in one of them", () => {
    const ids = (filter: Parameters<typeof filterLibrary>[1]["filter"]) => filterLibrary(all, { filter, query: "", agentId: "all", hostedSpaceIds: hosted }).map((i) => i.id);
    expect(ids("pages")).toEqual(["page"]);
    expect(ids("files")).toEqual(["file", "picture"]);
    expect(ids("spaces")).toEqual(["app", "shared"]);
    expect(ids("shared")).toEqual(["shared"]);
    expect(ids("all")).toHaveLength(all.length);
  });

  it("searches by name and tag within the chosen category and agent", () => {
    const tagged = item("tagged", { tags: ["Budget"] });
    const result = filterLibrary([file, tagged], { filter: "files", query: "budget", agentId: "all", hostedSpaceIds: hosted });
    expect(result.map((i) => i.id)).toEqual(["tagged"]);
    expect(filterLibrary([file], { filter: "files", query: "", agentId: "agent-other", hostedSpaceIds: hosted })).toEqual([]);
  });
});

describe("viewer and thumbnail choices", () => {
  it("opens each render type in its own viewer kind", () => {
    expect(viewerKind(page)).toBe("page");
    expect(viewerKind(picture)).toBe("image");
    expect(viewerKind(app)).toBe("space");
    expect(viewerKind(file)).toBe("file");
  });

  it("takes the thumbnail from the version first, then the image, else nothing", () => {
    expect(thumbnailSource(page)).toBe("thumbnail");
    expect(thumbnailSource(picture)).toBe("image");
    expect(thumbnailSource(file)).toBe("none");
  });
});
