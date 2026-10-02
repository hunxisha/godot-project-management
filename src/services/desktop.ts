/**
 * 桌面版(Tauri 宿主)特性开关。
 * 桌面版垫片(src/public/tauri-shim.js)会置 window.ztools.isDesktop = true;
 * ZTools 宿主上为 undefined。渲染层据此分流:项目页内嵌搜索框(桌面)vs ZTools 子输入栏(插件)。
 * 见 docs/tauri-migration-plan.md。
 */
export const IS_DESKTOP = typeof window !== 'undefined' && !!(window as any).ztools?.isDesktop
