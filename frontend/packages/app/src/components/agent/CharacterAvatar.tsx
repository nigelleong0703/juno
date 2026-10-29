import { useEffect, useRef, useState } from "react";
import type { CharacterSprite, CharacterState } from "../../characters";

const atlasLoads = new Map<string, Promise<void>>();

/** Fetches an atlas the first time a clip plays (cached per URL); never for avatars that stay static. */
function loadAtlas(url: string): Promise<void> {
  let load = atlasLoads.get(url);
  if (!load) {
    load = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.src = url;
    });
    atlasLoads.set(url, load);
  }
  return load;
}

/**
 * Fluffy character avatar: the transparent poster at rest; while `playing` the sprite atlas
 * of the chosen `clip` (frame 0 == poster, so the swap is seamless) is stepped at its fps by a small
 * timer that only moves background-position, paused while the tab is hidden. `clip` is null at rest
 * (tiny sizes, reduced motion, idle); a new clip keeps the current frame until its atlas has loaded.
 */
export function CharacterAvatar({
  sprite,
  px,
  clip,
}: {
  sprite: CharacterSprite;
  px: number;
  clip: CharacterState | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<CharacterState | null>(null);
  useEffect(() => {
    if (!clip) {
      setShown(null);
      return;
    }
    let alive = true;
    void loadAtlas(sprite.atlases[clip]).then(() => alive && setShown(clip));
    return () => {
      alive = false;
    };
  }, [clip, sprite]);
  const atlas = shown && sprite.atlases[shown];
  // Scale the cell so the rest-pose body fills the box, centred on the body; padding overflows.
  const k = px / sprite.body.size;
  const cellPx = sprite.frame * k;
  const place = {
    position: "absolute",
    width: cellPx,
    height: cellPx,
    left: px / 2 - sprite.body.cx * k,
    top: px / 2 - sprite.body.cy * k,
    maxWidth: "none",
  } as const;

  useEffect(() => {
    if (!atlas) return;
    let frame = 0;
    const draw = () => {
      const el = ref.current;
      if (!el || document.visibilityState === "hidden") return;
      el.style.backgroundPosition = `${-(frame % sprite.cols) * cellPx}px ${-Math.floor(frame / sprite.cols) * cellPx}px`;
      frame = (frame + 1) % sprite.count;
    };
    draw();
    const id = window.setInterval(draw, 1000 / sprite.fps);
    return () => window.clearInterval(id);
  }, [atlas, sprite, cellPx]);

  const rows = Math.ceil(sprite.count / sprite.cols);
  return (
    <span aria-hidden className="relative block" style={{ width: px, height: px }}>
      {atlas ? (
        <span
          ref={ref}
          style={{
            ...place,
            backgroundImage: `url(${atlas})`,
            backgroundSize: `${sprite.cols * cellPx}px ${rows * cellPx}px`,
            backgroundRepeat: "no-repeat",
          }}
        />
      ) : (
        <img src={sprite.poster} alt="" draggable={false} style={place} />
      )}
    </span>
  );
}
