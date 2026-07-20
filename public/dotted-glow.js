/**
 * Vanilla adaptation of Aceternity UI's DottedGlowBackground.
 * https://ui.aceternity.com/components/dotted-glow-background
 */
(() => {
  const canvas = document.querySelector("#dotted-glow-canvas");
  const container = canvas?.parentElement;
  const context = canvas?.getContext("2d");
  if (!canvas || !container || !context) return;

  const gap = 15;
  const radius = 0.95;
  const opacity = 0.42;
  const speedMin = 0.18;
  const speedMax = 0.48;
  const dotColor = "rgba(158, 158, 153, 0.54)";
  const glowColor = "rgba(239, 111, 46, 0.62)";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let width = 0;
  let height = 0;
  let dots = [];
  let frame = 0;
  let running = false;
  let visible = true;

  function buildDots() {
    dots = [];
    const columns = Math.ceil(width / gap) + 2;
    const rows = Math.ceil(height / gap) + 2;

    for (let column = -1; column < columns; column += 1) {
      for (let row = -1; row < rows; row += 1) {
        dots.push({
          x: column * gap + (row % 2 === 0 ? 0 : gap * 0.5),
          y: row * gap,
          phase: Math.random() * Math.PI * 2,
          speed: speedMin + Math.random() * (speedMax - speedMin),
        });
      }
    }
  }

  function resize() {
    const bounds = container.getBoundingClientRect();
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    width = Math.max(1, Math.floor(bounds.width));
    height = Math.max(1, Math.floor(bounds.height));
    canvas.width = Math.max(1, Math.floor(width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(height * pixelRatio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    buildDots();
    draw(performance.now(), false);
  }

  function draw(now, continueAnimation = true) {
    context.clearRect(0, 0, width, height);
    context.save();
    context.fillStyle = dotColor;

    const time = now / 1000;
    for (const dot of dots) {
      const mod = (time * dot.speed + dot.phase) % 2;
      const wave = mod < 1 ? mod : 2 - mod;
      const alpha = 0.18 + 0.5 * wave;

      if (alpha > 0.58) {
        const glow = (alpha - 0.58) / 0.42;
        context.shadowColor = glowColor;
        context.shadowBlur = 4 * glow;
      } else {
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
      }

      context.globalAlpha = alpha * opacity;
      context.beginPath();
      context.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
      context.fill();
    }

    context.restore();
    if (continueAnimation && running && visible) frame = requestAnimationFrame(draw);
  }

  function updateAnimation() {
    cancelAnimationFrame(frame);
    running = !reducedMotion.matches && !document.hidden;
    if (running && visible) frame = requestAnimationFrame(draw);
    else draw(performance.now(), false);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    updateAnimation();
  }, { threshold: 0.05 });
  visibilityObserver.observe(container);

  document.addEventListener("visibilitychange", updateAnimation);
  reducedMotion.addEventListener?.("change", updateAnimation);

  resize();
  updateAnimation();
})();
