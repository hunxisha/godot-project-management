// 市场资产安装:安装进度、已安装集合、版本选择器、安装确认层。
//
// 从 MarketplaceView.vue 抽出。安装是唯一会写目标项目目录的操作,它的进度回调必须按
// assetId 配对(否则并发/切换资产时进度会串到别的卡片上),这条约束原本只体现在一个
// 内联判断里,现在独立成模块并配了断言。
//
// 确认层流程(P1):install() 先走 previewAssetInstall 预下载并归纳安装计划——
//   · 插件(addon):目的地固定为 addons/,无歧义,直接安装(不弹确认);
//   · 素材(asset):弹确认层展示写入位置/顶层条目/冲突,并让用户决定唯一顶层目录
//     是「保留」还是「并入项目根」,选择按 slug 记入设置;
//   · 完整项目(project):确认层说明不可装,主按钮禁用。
// 确认或取消都要释放暂存包(stageId):确认后复用,取消后删除。
import { computed, ref, type Ref } from 'vue'
import { useInstallProgress } from './useInstallProgress'
import { getSettings, saveSettings, pickDirectory } from '../services/bridge'
import type { AddonInfo, InstallPlan, MarketAsset } from '../types/godot'

/** 确认层状态(非空时弹窗) */
export interface PreviewState {
  asset: MarketAsset
  /** 版本选择器进入时携带的版本 */
  version?: string
  stageId: string
  plan: InstallPlan
  title: string
  versionString: string
}

export interface UseMarketInstallOptions {
  /** 安装目标项目 */
  targetId: Ref<string>
  /** 目标项目已装插件(用于算「已安装」) */
  addons: Ref<AddonInfo[]>
  /** 安装成功后刷新已装插件 */
  reloadAddons: () => void
  /** 用户提示 */
  notify: (msg: string) => void
}

export function useMarketInstall(opts: UseMarketInstallOptions) {
  // 进度状态与阶段文案统一由 useInstallProgress 提供(与「更新」「切换版本」共用同一实现)
  const { progress: installing, percent, begin, onProgress, end, busy } = useInstallProgress()

  /** 目标项目已安装的市场资产 ID */
  const installedIds = computed(
    () => new Set(opts.addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
  )

  /** 确认层状态 */
  const preview = ref<PreviewState | null>(null)

  /** 正在预下载(确认层弹出之前)的资产 id:卡片据此显示「取消」按钮 */
  const previewingId = ref<string | null>(null)

  function assetMetaOf(asset: MarketAsset) {
    return {
      title: asset.title,
      author: asset.author,
      category: asset.category,
      iconUrl: asset.iconUrl,
      description: asset.description,
      storeUrl: asset.storeUrl
    }
  }

  // slug 记忆缓存:设置读取异步化后(阶段 A),确认层预填仍需同步接口,
  // 故在组合式函数初始化时拉一次设置进本地缓存,读写都走缓存再落库
  const stripPrefs = ref<Record<string, boolean>>({})
  getSettings().then((s) => { stripPrefs.value = s.assetStripTopDir || {} }).catch(() => { /* ignore */ })

  /** slug 记忆:下次安装同一资产的确认层预填同一选择(读写失败不影响安装) */
  function rememberStripPref(assetId: string, strip: boolean) {
    const slug = String(assetId).split('/')[1] || assetId
    stripPrefs.value = { ...stripPrefs.value, [slug]: strip }
    saveSettings({ assetStripTopDir: stripPrefs.value }).catch(() => { /* ignore */ })
  }

  /** 确认层预填:上次对该资产的选择;没记过默认保留顶层目录(与官方编辑器行为一致) */
  function defaultStripOf(assetId: string): boolean {
    const slug = String(assetId).split('/')[1] || ''
    if (!slug) return false
    return stripPrefs.value[slug] === true
  }

  /** 第二步:真正的安装(带 stageId 复用暂存包;无 stageId 时 preload 自行下载) */
  async function doInstall(asset: MarketAsset, version: string | undefined, stageId: string | undefined, stripTopDir: boolean | undefined) {
    if (!opts.targetId.value || busy()) {
      // 进不来了就把暂存包释放掉,别留孤儿文件
      if (stageId) window.services.cancelStagedAsset(stageId)
      return
    }
    begin(asset.assetId)
    const r = await window.services.installAsset(
      {
        projectId: opts.targetId.value,
        assetId: asset.assetId,
        version,
        stageId,
        stripTopDir,
        assetMeta: assetMetaOf(asset)
      },
      (p) => onProgress(asset.assetId, p)
    )
    end()
    if (r.ok) {
      opts.notify(`已安装 ${r.addon?.title}${version ? ` ${r.addon?.versionString}` : ''}${r.addon?.enabled ? '(已启用)' : ''}`)
      opts.reloadAddons()
    } else {
      opts.notify(r.error || '安装失败')
    }
  }

  /** 第一步:预下载并归纳安装计划,再按类型分流 */
  async function install(asset: MarketAsset, version?: string): Promise<void> {
    if (!opts.targetId.value || busy() || preview.value) return
    begin(asset.assetId)
    let r
    previewingId.value = asset.assetId
    try {
      r = await window.services.previewAssetInstall(
        { projectId: opts.targetId.value, assetId: asset.assetId, version },
        (p) => onProgress(asset.assetId, p)
      )
    } catch (e: any) {
      r = { ok: false, error: e?.message || String(e) }
    } finally {
      previewingId.value = null
      end()
    }
    if (!r.ok || !r.plan || !r.stageId) {
      // 用户主动取消预览下载不算失败,静默回到初始状态
      if (r.error !== '已取消') opts.notify(r.error || '获取资产信息失败')
      return
    }
    // 插件目的地固定为 addons/,没有需要用户裁决的歧义,直接装(保持原有一步到位的体验)
    if (r.plan.kind === 'addon') {
      await doInstall(asset, version, r.stageId, undefined)
      return
    }
    preview.value = {
      asset,
      version,
      stageId: r.stageId,
      plan: r.plan,
      title: r.title || asset.title,
      versionString: r.versionString || ''
    }
  }

  /** 确认层点「安装」:记住剥离选择并继续(完整项目在确认层被禁用,这里兜底不再安装) */
  async function confirmPreview(stripTopDir: boolean) {
    const p = preview.value
    if (!p || p.plan.kind === 'project') return
    preview.value = null
    if (p.plan.singleTopDir) rememberStripPref(p.asset.assetId, stripTopDir)
    await doInstall(p.asset, p.version, p.stageId, p.plan.singleTopDir ? stripTopDir : undefined)
  }

  /** 取消确认层:释放暂存包 */
  function cancelPreview() {
    const p = preview.value
    if (!p) return
    preview.value = null
    window.services.cancelStagedAsset(p.stageId)
  }

  /** 取消进行中的预览下载(仅确认层弹出之前有效;幂等) */
  function cancelPreviewDownload(assetId: string) {
    window.services.cancelAssetPreview(assetId)
  }

  /** 确认层「另存为新项目」:选个父目录,把完整项目解压登记为新项目 */
  async function saveAsProject() {
    const p = preview.value
    if (!p || p.plan.kind !== 'project') return
    const dir = await pickDirectory(`选择「${p.title}」要保存到的位置`)
    if (!dir) return // 取消选择:确认层保持打开,暂存包留着可重试
    preview.value = null
    begin(p.asset.assetId)
    let r
    try {
      r = await window.services.saveAssetAsProject(
        { assetId: p.asset.assetId, version: p.version, stageId: p.stageId, destRoot: dir },
        (prog) => onProgress(p.asset.assetId, prog)
      )
    } catch (e: any) {
      r = { ok: false, error: e?.message || String(e) }
    } finally {
      end()
    }
    if (r.ok) opts.notify(`已添加项目「${r.projectName || p.title}」`)
    else opts.notify(r.error || '另存失败')
  }

  /** 仅下载 zip 到本地(不安装、不写记录);不需要安装目标,只是复用卡片进度显示 */
  async function saveZip(asset: MarketAsset, version?: string) {
    if (busy() || preview.value) return
    const dir = await pickDirectory(`选择「${asset.title}」的保存位置`)
    if (!dir) return
    begin(asset.assetId)
    let r
    try {
      r = await window.services.downloadAssetZip(
        { assetId: asset.assetId, version, destDir: dir },
        (p) => onProgress(asset.assetId, p)
      )
    } catch (e: any) {
      r = { ok: false, error: e?.message || String(e) }
    } finally {
      end()
    }
    if (r.ok) opts.notify(`已下载 ${r.file} 到 ${dir}`)
    else opts.notify(r.error || '下载失败')
  }

  // ---------- 版本选择器 ----------

  /** 只保留「要选哪个资产」;release 列表与加载态由对话框自己管 */
  const picker = ref<{ asset: MarketAsset } | null>(null)

  function openPicker(a: MarketAsset) {
    if (busy() || preview.value) return
    picker.value = { asset: a }
  }

  /** 从版本选择器安装指定版本 */
  function installFromPicker(version: string) {
    const a = picker.value?.asset
    if (!a || busy() || preview.value) return
    picker.value = null
    return install(a, version)
  }

  return {
    installing,
    installedIds,
    picker,
    preview,
    previewingId,
    install,
    openPicker,
    installFromPicker,
    confirmPreview,
    cancelPreview,
    cancelPreviewDownload,
    saveAsProject,
    saveZip,
    defaultStripOf,
    percent
  }
}
