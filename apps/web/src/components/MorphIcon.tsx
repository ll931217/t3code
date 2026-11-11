import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

import { useReduceEffects } from "../lib/reduceEffects";

export function MorphIcon({ reducedMotion, ...props }: MorphIconProps) {
  const reduceEffects = useReduceEffects();
  return (
    <BaseMorphIcon
      reducedMotion={reduceEffects ? "always" : (reducedMotion ?? "user")}
      {...props}
    />
  );
}
