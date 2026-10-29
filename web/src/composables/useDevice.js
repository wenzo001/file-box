import { useMediaQuery } from '@vueuse/core';

// 唯一的"手机档"判据：与 files.css / shell.css 的 @media (max-width: 700px) 必须同一条，
// 否则 JS 渲染了单层列表、CSS 却按桌面规则排版（或反之）。
export const MOBILE_QUERY = '(max-width: 700px)';

export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY);
}

// 软键盘高度：iOS/Android 上 visualViewport 会比 layout viewport 矮一截。
// 底部抽屉和动作栏是 position:fixed，默认停在 layout viewport 底 = 键盘背面，
// 所以把这段距离发布成 --kb-inset，让贴底的东西自己抬上来。
export function useKeyboardInset() {
  const apply = () => {
    const vv = window.visualViewport;
    const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
  };
  apply();
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  return () => {
    window.visualViewport?.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
  };
}
