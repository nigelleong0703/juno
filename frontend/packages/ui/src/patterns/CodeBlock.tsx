import type { BundledLanguage } from "shiki";
import type { ReactNode } from "react";
import {
  CodeBlock as AiCodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/ai/code-block";
import { cn } from "@/lib/utils";

export interface CodeBlockProps {
  /** Code to highlight. */
  code: string;
  /** Programming language. */
  language?: string;
  /** Optional filename or header shown on the left. */
  filename?: ReactNode;
  showLineNumbers?: boolean;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  className?: string;
}

/**
 * Code block composed from Vercel AI Elements' CodeBlock, with a header that
 * carries the filename/language and a copy action.
 */
export function CodeBlock({
  code,
  language = "text",
  filename,
  showLineNumbers,
  wrap = false,
  className,
}: CodeBlockProps) {
  return (
    <AiCodeBlock
      code={code}
      language={language as BundledLanguage}
      showLineNumbers={showLineNumbers}
      className={cn(wrap && "[&_pre]:whitespace-pre-wrap [&_pre]:break-words", className)}
    >
      <CodeBlockHeader>
        {filename ? (
          <CodeBlockFilename>{filename}</CodeBlockFilename>
        ) : (
          <CodeBlockTitle>{language}</CodeBlockTitle>
        )}
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </AiCodeBlock>
  );
}
