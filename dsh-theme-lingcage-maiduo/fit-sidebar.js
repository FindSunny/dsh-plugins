// 量出左侧栏的真实宽度，写进 --dsh-maiduo-strip。
//
// 主题里人像条（body::after）和视频的左边界的都用这个变量；桌面版侧栏宽度会随窗口/折叠变化，
// 写死 248px 会露出右侧一截底色。这里用启发式找"贴左边、近乎满高、窄于半屏"的最宽元素，
// 再用 ResizeObserver 跟随尺寸变化。
(() => {
  if (window.__dshMaiduoFit === 1) return;
  window.__dshMaiduoFit = 1;

  const VAR = '--dsh-maiduo-strip';
  const MIN_WIDTH = 150;

  const apply = (width) => {
    if (!Number.isFinite(width) || width < MIN_WIDTH) return;
    // 上限保护：量错元素时会得到一个很大的宽度，导致视频 left 越过窗口右缘、整块不可见
    const max = Math.min(360, Math.max(MIN_WIDTH, window.innerWidth * 0.45));
    const clamped = Math.min(width, max);
    document.documentElement.style.setProperty(VAR, `${Math.round(clamped)}px`);
    window.__dshMaiduoStrip = { raw: Math.round(width), used: Math.round(clamped), max: Math.round(max) };
  };

  const findSidebar = () => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestWidth = 0;
    for (const el of document.querySelectorAll('#root *')) {
      const rect = el.getBoundingClientRect();
      if (rect.left > 2) continue;
      if (rect.height < vh * 0.85) continue;
      if (rect.width < MIN_WIDTH || rect.width > vw * 0.55) continue;
      if (rect.width > bestWidth) {
        bestWidth = rect.width;
        best = el;
      }
    }
    return best;
  };

  let observed = null;
  const observe = (el) => {
    if (observed === el) return;
    observed = el;
    try {
      const ro = new ResizeObserver(() => apply(el.getBoundingClientRect().width));
      ro.observe(el);
    } catch {
      /* 老引擎没有 ResizeObserver 就只测一次 */
    }
  };

  let tries = 0;
  const tick = () => {
    const el = findSidebar();
    if (el !== null) {
      apply(el.getBoundingClientRect().width);
      observe(el);
      return;
    }
    tries += 1;
    if (tries < 80) setTimeout(tick, 120); // 约 10 秒内持续尝试
  };

  // 窗口尺寸变化时重新找元素、重新量：侧栏在窄窗口下可能换布局或被替换
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      tries = 0;
      tick();
    }, 120);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true });
  else tick();
  window.addEventListener('resize', onResize);
})();
