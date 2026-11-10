import { useEffect, useRef } from "react";
import { Animated, useAnimatedValue } from "react-native";
import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";

export function AgentTrafficPulse(props: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  visible: boolean;
}) {
  const progress = useAnimatedValue(0);
  const played = useRef(false);
  const active = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one native animation visualizes one server delivery event and stops when the app is hidden
  useEffect(() => {
    if (played.current) return;
    played.current = true;
    if (!props.visible || !active || reducedMotion) return;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 850,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      progress.setValue(1);
    };
  }, [active, props.visible, reducedMotion, progress]);
  if (!props.visible || !active || reducedMotion) return null;
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute size-2 rounded-full bg-primary"
      style={{
        opacity: progress.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [props.from.x, props.to.x],
            }),
          },
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [props.from.y, props.to.y],
            }),
          },
        ],
      }}
    />
  );
}
