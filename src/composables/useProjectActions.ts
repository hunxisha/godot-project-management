// 项目启动动作:Dashboard 与项目页共用
import { getSettings, hideMainWindow, notify, openPath } from '../services/bridge'
import type { GodotProject, OpenAction } from '../types/godot'

/**
 * 用指定动作(默认读设置)打开项目,成功后隐藏主窗口并回写打开统计。
 * p 为响应式列表中的对象,成功时原地更新。
 */
export function openProjectAction(p: GodotProject & { _id: string }, action?: OpenAction) {
  const settings = getSettings()
  const act = action || settings.defaultOpenAction
  if (act === 'folder') {
    openPath(p.path)
    p.lastOpenedAt = Date.now()
    p.openCount = (p.openCount || 0) + 1
    return
  }
  const r = window.services.launchProject({ projectId: p._id, action: act })
  if (r.ok && r.project) {
    const { _id, ...data } = r.project
    Object.assign(p, data)
    hideMainWindow()
  } else {
    notify(r.error || '启动失败')
  }
}
