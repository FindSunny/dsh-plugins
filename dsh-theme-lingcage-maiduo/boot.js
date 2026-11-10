// 右侧工作区循环背景视频（本地私有主题的一部分）。
// 注入方式：
//   - html 行先插入 <video data-dsh-maiduo>（不依赖 JS）；
//   - 本脚本（内联 script 行，不会被 boot await）接管：强制 muted、尝试播放、失败退避重试；
//   - 顺带回发 /theme-maiduo/ack?stage=…，用于区分「脚本没跑」和「视频被上层挡住」。
(() => {
  if (window.__dshMaiduoVideo === 1) return;
  window.__dshMaiduoVideo = 1;

  // 路径由 index.js 注入（它和路由常量同源），这里只留兜底 —— 之前写死旧路径导致回执和
  // 自建视频都打到 404 上
  const PATHS = window.__dshMaiduoPaths || {};
  const SRC = PATHS.video || '/theme-maiduo/v2/bg.mp4';
  const ACK = PATHS.ack || '/theme-maiduo/v2/ack';
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
      // ⚠️ 替换元素必须显式给宽高：只写四边定位时浏览器按固有尺寸排版（1920×1080），
      // right/bottom 被忽略，窗口一窄就只剩画面左侧、人被挤出窗口
      height: '100vh',
      left: 'var(--dsh-maiduo-strip, 248px)',
      width: 'calc(100vw - var(--dsh-maiduo-strip, 248px))',
      objectFit: 'cover',
      // 锚点定在她身上（画面 62% 处）：窗口变窄只裁两侧樱花，人始终在画面里
      objectPosition: '62% center',
      zIndex: '2147483000',
      pointerEvents: 'none',
      opacity: 'var(--dsh-maiduo-video-opacity, 0.32)',
      // 遮罩按**像素**，且过渡压得很短：只在贴近侧栏的 ~110px 内淡入，
      // 否则侧栏右边会留一条纯黑带（看起来"左侧全黑、很突兀"）
      maskImage:
        'linear-gradient(to right, rgba(0,0,0,0) 0px, rgba(0,0,0,0.3) 20px, rgba(0,0,0,0.72) 60px, rgba(0,0,0,0.9) 110px, rgba(0,0,0,0.95) 100%)',
      webkitMaskImage:
        'linear-gradient(to right, rgba(0,0,0,0) 0px, rgba(0,0,0,0.3) 20px, rgba(0,0,0,0.72) 60px, rgba(0,0,0,0.9) 110px, rgba(0,0,0,0.95) 100%)',
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
