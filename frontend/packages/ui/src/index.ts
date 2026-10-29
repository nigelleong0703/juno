// @agent-desktop/ui — design system entry point
export * from "./lib";
export * from "./theme";
export * from "./primitives";
export * from "./patterns";
export * from "./ai";

// `CodeBlock` is exported by both layers: `patterns/CodeBlock` is the public
// wrapper that composes the AI Elements primitive, so it owns the name at the
// package root. (The raw AI Elements primitive stays available from
// `@agent-desktop/ui/ai`.) Without this explicit re-export the two star exports
// collide and the name would be dropped entirely.
export { CodeBlock } from "./patterns/CodeBlock";
