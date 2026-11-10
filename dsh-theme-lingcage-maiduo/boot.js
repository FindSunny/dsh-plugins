// 右侧工作区循环背景视频（本地私有主题的一部分）。
// 注入方式：
//   - html 行先插入 <video data-dsh-maiduo>（不依赖 JS）；
//   - 本脚本（内联 script 行，不会被 boot await）接管：强制 muted、尝试播放、失败退避重试；
//   - 顺带回发 /theme-maiduo/ack?stage=…，用于区分「脚本没跑」和「视频被上层挡住」。
(() => {
  if (window.__dshMaiduoVideo === 1) return;
  window.__dshMaiduoVideo = 1;

  const SRC = '/theme-maiduo/bg.mp4';
  const ACK = '/theme-maiduo/ack';
  const MAX_ATTEMPTS = 20;
  let attempts = 0;

  const ack = (stage) => {
    try {
      const url = `${ACK}?stage=${encodeURIComponent(stage)}`;
      if (typeof fetch === 'function') fetch(url, { cache: 'no-store' }).catch(() => {});
    } catch {
      /* 诊断而已 */
    }
  };

  const tryPlay = (video) => {
    video.muted = true;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
  };

  const create = () => {
    const video = document.createElement('video');
    video.src = SRC;
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('data-dsh-maiduo', '');
    video.setAttribute('aria-hidden', 'true');
    Object.assign(video.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      // 素材是横屏 1920×1080，人物在画面右半边：铺满右侧工作区
      left: 'var(--dsh-maiduo-strip, 248px)',
      objectFit: 'cover',
      // 她在画面右半边：靠右裁，保证人不被裁掉
      objectPosition: 'right center',
      zIndex: '2147483000',
      pointerEvents: 'none',
      opacity: 'var(--dsh-maiduo-video-opacity, 0.42)',
      // 遮罩：只挡最左 26%（基本是樱花），往右快速淡入 —— 让画面中偏左的"手"也能看到
      maskImage:
        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.95) 100%)',
      webkitMaskImage:
        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.95) 100%)',
      filter: 'saturate(0.95)',
    });
    return video;
  };

  function boot() {
    if (!document.body) return;

    const existing = document.querySelector('video[data-dsh-maiduo]');
    const video = existing === null ? create() : existing;

    video.addEventListener(
      'error',
      () => {
        video.remove();
        if (attempts >= MAX_ATTEMPTS) return;
        attempts += 1;
        setTimeout(boot, Math.min(500 * attempts, 3000));
      },
      { once: true },
    );

    video.addEventListener('loadeddata', () => ack(`loaded-${String(attempts)}`), { once: true });

    if (existing === null) document.body.appendChild(video);
    tryPlay(video);
    ack(existing === null ? 'create' : 'adopt');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
