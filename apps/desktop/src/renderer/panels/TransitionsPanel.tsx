// The Transitions panel: the browse-and-apply half of transition
// discoverability (#16). Nine static cards — Crossfade, and Wipe/Slide per
// motion direction — fully expanded because direction is half the effect for
// the directional kinds (CONTEXT.md § Transitions), and so a future kind
// (Push) is "add four cards", not an information-architecture change.
//
// A card click dispatches through the same `applyTransitionAtPlayhead` kernel
// as the palette command and the strip button — only the (kind, direction)
// pair differs — so the panel can never disagree with them about WHERE a
// transition lands. No drag-to-cut and no animated previews: post-v1.

import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blend,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TransitionDirection } from "../ipc";
import {
  applyTransitionAtPlayhead,
  useHasTransitionCut,
} from "../timeline/applyTransition";
import {
  TRANSITION_DIRECTIONS,
  type TransitionKindName,
} from "../timeline/transitions";

// Direction glyphs are per KIND: a wipe's boundary sweeps (plain arrow), a
// slide's incoming capture travels (arrow with a tail line). Both depict the
// MOTION direction, matching the glossary and the i18n comments.
const WIPE_ICONS: Record<TransitionDirection, LucideIcon> = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown,
};
const SLIDE_ICONS: Record<TransitionDirection, LucideIcon> = {
  left: MoveLeft,
  right: MoveRight,
  up: MoveUp,
  down: MoveDown,
};

interface TransitionCard {
  kind: TransitionKindName;
  direction?: TransitionDirection;
  icon: LucideIcon;
}

interface TransitionGroup {
  kind: TransitionKindName;
  labelKey: string;
  cards: TransitionCard[];
}

const GROUPS: readonly TransitionGroup[] = [
  {
    kind: "Crossfade",
    labelKey: "transitions.kind_crossfade",
    cards: [{ kind: "Crossfade", icon: Blend }],
  },
  {
    kind: "Wipe",
    labelKey: "transitions.kind_wipe",
    cards: TRANSITION_DIRECTIONS.map((direction) => ({
      kind: "Wipe" as const,
      direction,
      icon: WIPE_ICONS[direction],
    })),
  },
  {
    kind: "Slide",
    labelKey: "transitions.kind_slide",
    cards: TRANSITION_DIRECTIONS.map((direction) => ({
      kind: "Slide" as const,
      direction,
      icon: SLIDE_ICONS[direction],
    })),
  },
];

function cardTestId(card: TransitionCard): string {
  return card.direction
    ? `transition-card-${card.kind.toLowerCase()}-${card.direction}`
    : `transition-card-${card.kind.toLowerCase()}`;
}

export function TransitionsPanel({
  onMutated,
}: {
  onMutated: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const hasCut = useHasTransitionCut();

  // Full "Add wipe · Left" phrasing — the cut context menu's own entry keys,
  // reused so the two surfaces name one action identically.
  const cardLabel = (card: TransitionCard): string => {
    if (card.kind === "Crossfade") return t("timeline.add_transition_crossfade");
    const direction = t(`transitions.direction_${card.direction}`);
    return card.kind === "Wipe"
      ? t("timeline.add_transition_wipe", { direction })
      : t("timeline.add_transition_slide", { direction });
  };

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="transitions-panel">
      {!hasCut && (
        <p className="text-xs text-muted-foreground">
          {t("transitions.panel_no_target_hint")}
        </p>
      )}
      {GROUPS.map((group) => (
        <section key={group.kind} aria-label={t(group.labelKey)}>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t(group.labelKey)}
          </h3>
          <div className="grid grid-cols-2 gap-1">
            {group.cards.map((card) => {
              const label = cardLabel(card);
              return (
                <Button
                  key={cardTestId(card)}
                  variant="outline"
                  size="sm"
                  className="h-auto flex-col gap-1 px-2 py-2"
                  disabled={!hasCut}
                  data-testid={cardTestId(card)}
                  aria-label={label}
                  // Disabled buttons keep an explanatory tooltip, the
                  // clearRange rule: restating an unusable label reads as
                  // broken.
                  title={hasCut ? label : t("transitions.no_target")}
                  onClick={() =>
                    void applyTransitionAtPlayhead(
                      card.kind,
                      card.direction,
                      onMutated,
                    )
                  }
                >
                  <card.icon size={16} aria-hidden="true" />
                  <span className="text-xs">
                    {card.direction
                      ? t(`transitions.direction_${card.direction}`)
                      : t("transitions.kind_crossfade")}
                  </span>
                </Button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
