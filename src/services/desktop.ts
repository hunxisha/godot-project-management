/**
 * 桌面版(Electron 宿主)特性开关。
 * 桌面版 preload 垫片(desktop/preload/ztshim.js)会置 window.ztools.isDesktop = true;
 * ZTools 宿主上为 undefined。渲染层据此分流:项目页内嵌搜索框(桌面)vs ZTools 子输入栏(插件)。
 * 见 docs/desktop-app-plan.md §2.2。
 */
export const IS_DESKTOP = typeof window !== 'undefined' && !!(window as any).ztools?.isDesktop
