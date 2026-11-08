// Wait for the real surface animation, including pauses and reduced motion.
// Cleanup prevents an interrupted or replaced preview from completing a newer one.
export function afterOverlayEntry(node, onEntered) {
  let active = true;
  let timer;
  const finish = () => {
    if (!active) return;
    active = false;
    onEntered();
  };
  if (typeof node.getAnimations === "function") {
    const animations = node.getAnimations().filter((animation) =>
      animation.effect?.target === node);
    Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
  } else {
    // Older engines without Web Animations still use the CSS entry duration.
    const style = getComputedStyle(node);
    const time = (value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000) || 0;
    const durations = style.animationDuration.split(",").map(time);
    const delays = style.animationDelay.split(",").map(time);
    const duration = Math.max(0, ...style.animationName.split(",").map((name, index) =>
      name.trim() === "none" ? 0 : durations[index % durations.length] + delays[index % delays.length]));
    timer = setTimeout(finish, duration);
  }
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
