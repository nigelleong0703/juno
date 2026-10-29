import { JunoBean } from "../brand/JunoBean";
import "./auth.css";

/** Centered brand lockup (presentation only): horizontal mascot + wordmark,
 * one positioning sentence. No subline, no marketing sections. */
export function AccountScene({ compact }: { compact?: boolean }) {
  return (
    <div className="al1-scene" data-compact={compact ? "true" : "false"}>
      <div className="al1-brand-lockup">
        <JunoBean height={96} className="al1-mascot" />
        <p className="al1-wordmark">Juno</p>
      </div>
      <p className="al1-tagline">Your team of persistent AI agents, each with a computer of their own.</p>
    </div>
  );
}
