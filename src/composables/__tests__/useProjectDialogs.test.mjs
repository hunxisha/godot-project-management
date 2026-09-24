// 项目新建 / 删除对话框测试。
//
// 这两块都从 ProjectsView.vue 抽出,而且都涉及「默认值」与「破坏性操作」:
//   · 新建:父目录取最近项目的上级目录、引擎取设置默认值 —— 默认错了用户会在错误目录建项目
//   · 删除:是否连带删除磁盘文件由全局设置(ask/always/never)与勾选共同决定 —— 判错会删数据
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useprojectcreate', 'useprojectdelete', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useProjectCreate } = await import(pathToFileURL(path.join(OUT, 'useprojectcreate.mjs')).href)
const { useProjectDelete } = await import(pathToFileURL(path.join(OUT, 'useprojectdelete.mjs')).href)

// ---------- 桩 ----------
let createCalls = []
let createResult = null
let removeCalls = []
let removeResult = null
let pickedDir = null
const notifications = []

global.window = {
  services: {
    createProject(opts) { createCalls.push(opts); return createResult },
    removeProject(id, deleteFiles) { removeCalls.push({ id, deleteFiles }); return removeResult }
  }
}
// pickDirectory 走 services/bridge → window.ztools.showOpenDialog,返回「路径数组或 undefined」
global.window.ztools = {
  showOpenDialog: () => pickedDir,
  db: { get: () => null, put: () => ({ ok: true }), remove: () => ({ ok: true }), allDocs: () => [] }
}

function reset() {
  createCalls = []
  removeCalls = []
  notifications.length = 0
  pickedDir = null
  createResult = { ok: true, project: { id: 'godot/project/new1', name: '新项目' } }
  removeResult = { ok: true }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const PROJ = (id, name, over = {}) => ({
  _id: `godot/project/${id}`, id, name, path: `E:\\Godot\\${name}`, addedAt: 1, favorite: false, ...over
})

async function main() {
  // ---------- 1. 新建:预填 ----------
  section('1. openCreate:预填父目录与引擎版本')
  {
    reset()
    const projects = ref([
      PROJ('a', 'Old', { lastOpenedAt: 100 }),
      PROJ('b', 'Recent', { path: 'E:\\Work\\Recent', lastOpenedAt: 900 })
    ])
    const versions = ref([
      { _id: 'godot/version/4.7', tag: '4.7-stable' },
      { _id: 'godot/version/4.3', tag: '4.3-stable' }
    ])
    const c = useProjectCreate({
      projects, versions, defaultVersionId: 'godot/version/4.3',
      notify: (m) => notifications.push(m), reload: () => {}, openProject: () => {}
    })
    ok(c.showCreate.value === false, '初始不显示对话框')
    c.openCreate()
    ok(c.showCreate.value === true, 'openCreate 打开对话框')
    ok(c.cParent.value === 'E:\\Work', '父目录预填「最近打开项目」的上级目录', c.cParent.value)
    ok(c.cVersionId.value === 'godot/version/4.3', '引擎取设置里的默认版本', c.cVersionId.value)
    ok(c.cRenderer.value === 'forward_plus', '渲染器默认 forward_plus')
    ok(c.cOpen.value === true, '默认勾选「创建后打开」')
    ok(c.cName.value === '', '名称为空')

    // 从未打开过的项目:用 addedAt 参与「最近」比较(既有语义,这里钉住)
    projects.value = [
      PROJ('x', 'Opened', { path: 'E:\\Old\\Opened', lastOpenedAt: 100 }),
      PROJ('y', 'NeverOpened', { path: 'E:\\Late\\NeverOpened', addedAt: 5000 })
    ]
    c.openCreate()
    ok(c.cParent.value === 'E:\\Late', '未打开过的项目按 addedAt 参与比较', c.cParent.value)
    await sleep()
  }

  // ---------- 2. 新建:默认版本回退 ----------
  section('2. 引擎默认值的回退顺序')
  {
    reset()
    const projects = ref([])
    const versions = ref([{ _id: 'godot/version/4.7', tag: '4.7-stable' }])
    const mk = (defaultVersionId) => useProjectCreate({
      projects, versions, defaultVersionId,
      notify: () => {}, reload: () => {}, openProject: () => {}
    })
    const c1 = mk('不存在的版本')
    c1.openCreate()
    ok(c1.cVersionId.value === 'godot/version/4.7', '设置里的默认版本不存在时回退到第一个已装版本', c1.cVersionId.value)

    const c2 = useProjectCreate({
      projects: ref([]), versions: ref([]), defaultVersionId: undefined,
      notify: () => {}, reload: () => {}, openProject: () => {}
    })
    c2.openCreate()
    ok(c2.cVersionId.value === '', '一个引擎都没装时留空', c2.cVersionId.value)
    ok(c2.cParent.value === '', '没有任何项目时父目录留空', c2.cParent.value)
    await sleep()
  }

  // ---------- 3. 新建:目录预览 ----------
  section('3. cPreview:目标路径预览')
  {
    reset()
    const c = useProjectCreate({
      projects: ref([]), versions: ref([]),
      notify: () => {}, reload: () => {}, openProject: () => {}
    })
    ok(c.cPreview.value === '', '父目录为空时预览为空')
    c.cParent.value = 'E:\\Work'
    ok(c.cPreview.value === 'E:\\Work', '只有父目录时预览即父目录')
    c.cParent.value = 'E:\\Work\\'
    c.cName.value = 'MyGame'
    ok(c.cPreview.value === 'E:\\Work\\MyGame', '去掉父目录末尾分隔符再拼接', c.cPreview.value)
    c.cName.value = '  '
    ok(c.cPreview.value === 'E:\\Work', '项目名只有空白时退回父目录')

    // chooseParent:选中目录则更新,取消则保持原值
    pickedDir = ['D:\\Games']
    c.chooseParent()
    ok(c.cParent.value === 'D:\\Games', '选中目录后写入父目录', c.cParent.value)
    pickedDir = undefined
    c.chooseParent()
    ok(c.cParent.value === 'D:\\Games', '取消选择时保持原值(不被清空)', c.cParent.value)
    await sleep()
  }

  // ---------- 4. 新建:提交 ----------
  section('4. submitCreate')
  {
    reset()
    const projects = ref([PROJ('a', 'Old')])
    const versions = ref([{ _id: 'godot/version/4.7', tag: '4.7-stable' }])
    let reloaded = 0
    let opened = []
    const c = useProjectCreate({
      projects, versions, defaultVersionId: 'godot/version/4.7',
      notify: (m) => notifications.push(m),
      // submitCreate 依赖 reload() 先把新项目写回列表,才能按 id 找到那一行去打开
      reload: () => { reloaded++; projects.value = [...projects.value, PROJ('new1', '新项目')] },
      openProject: (row) => opened.push(row)
    })
    c.openCreate()
    c.cName.value = '  NewGame  '
    c.cParent.value = '  E:\\Work  '
    c.submitCreate()
    ok(createCalls.length === 1, '发起一次创建')
    ok(createCalls[0].name === 'NewGame', '名称已 trim', createCalls[0].name)
    ok(createCalls[0].parentDir === 'E:\\Work', '父目录已 trim')
    ok(createCalls[0].renderer === 'forward_plus', '渲染器透传')
    ok(createCalls[0].versionTag === '4.7-stable' && createCalls[0].versionId === 'godot/version/4.7', '引擎 tag 与 id 都透传')
    ok(c.showCreate.value === false, '成功后关闭对话框')
    ok(reloaded === 1, '成功后重读列表')
    ok(/已创建项目/.test(notifications[0] || ''), '提示创建成功', String(notifications[0]))
    ok(opened.length === 1, '勾选了「创建后打开」时立即打开')

    // 名称/父目录为空时不提交
    reset()
    const c2 = useProjectCreate({
      projects: ref([]), versions: ref([]),
      notify: () => {}, reload: () => {}, openProject: () => {}
    })
    c2.openCreate()
    c2.cName.value = ''
    c2.cParent.value = 'E:\\Work'
    c2.submitCreate()
    ok(createCalls.length === 0, '名称为空时不提交', String(createCalls.length))
    c2.cName.value = 'X'
    c2.cParent.value = ''
    c2.submitCreate()
    ok(createCalls.length === 0, '父目录为空时不提交')

    // 失败
    reset()
    createResult = { ok: false, error: '目录已存在' }
    const c3 = useProjectCreate({
      projects: ref([PROJ('a', 'Old')]), versions: ref([]),
      notify: (m) => notifications.push(m), reload: () => { reloaded++ }, openProject: () => {}
    })
    c3.openCreate()
    c3.cName.value = 'X'
    c3.cParent.value = 'E:\\Work'
    c3.submitCreate()
    ok(notifications[0] === '目录已存在', '失败时提示服务端原因', String(notifications[0]))
    ok(c3.showCreate.value === true, '失败时对话框保持打开(便于改)')
    await sleep()
  }

  // ---------- 5. 删除:文件策略 ----------
  section('5. 删除:ask / always / never 三种策略')
  {
    const mk = (policy) => {
      reset()
      const projects = ref([PROJ('a', 'Alpha')])
      const d = useProjectDelete({
        projects, policy,
        notify: (m) => notifications.push(m),
        dropLocal: (id) => { projects.value = projects.value.filter((p) => p._id !== id) }
      })
      return { d, projects }
    }

    // never:无论如何都不删文件
    let { d } = mk('never')
    d.askDelete(PROJ('a', 'Alpha'))
    ok(d.delFiles.value === false, 'policy=never 时不预勾选')
    d.delFiles.value = true
    ok(d.willDeleteFiles() === false, 'policy=never 时即使勾选也不删文件')
    d.confirmDelete()
    ok(removeCalls[0].deleteFiles === false, '传给服务端的 deleteFiles=false', String(removeCalls[0].deleteFiles))

    // always:默认勾选
    ;({ d } = mk('always'))
    d.askDelete(PROJ('a', 'Alpha'))
    ok(d.delFiles.value === true, 'policy=always 时默认勾选')
    ok(d.willDeleteFiles() === true, 'policy=always 时默认删文件')
    d.confirmDelete()
    ok(removeCalls[0].deleteFiles === true, '传给服务端的 deleteFiles=true')

    // ask:跟随勾选
    ;({ d } = mk('ask'))
    d.askDelete(PROJ('a', 'Alpha'))
    ok(d.delFiles.value === false, 'policy=ask 时不预勾选')
    d.delFiles.value = true
    ok(d.willDeleteFiles() === true, 'policy=ask 时勾选即删文件')
    d.delFiles.value = false
    ok(d.willDeleteFiles() === false, 'policy=ask 时取消勾选即只移记录')

    // 策略缺省(设置里没这一项)
    const projects = ref([PROJ('a', 'Alpha')])
    const dn = useProjectDelete({ projects, notify: () => {}, dropLocal: () => {} })
    dn.askDelete(PROJ('a', 'Alpha'))
    ok(dn.willDeleteFiles() === false, '未给策略时保守处理:不删文件')
    await sleep()
  }

  // ---------- 6. 删除:执行结果 ----------
  section('6. confirmDelete:成功 / 失败 / 无目标')
  {
    reset()
    const projects = ref([PROJ('a', 'Alpha'), PROJ('b', 'Beta')])
    const d = useProjectDelete({
      projects, policy: 'ask',
      notify: (m) => notifications.push(m),
      dropLocal: (id) => { projects.value = projects.value.filter((p) => p._id !== id) }
    })
    d.confirmDelete()
    ok(removeCalls.length === 0, '没有目标时不发请求(避免确认框关闭时误删)')
    ok(notifications.length === 0, '也不提示')

    d.askDelete(PROJ('a', 'Alpha'))
    d.confirmDelete()
    ok(removeCalls[0].id === 'godot/project/a', '删除正确的项目', removeCalls[0].id)
    ok(d.showDelete.value === false, '成功后关闭确认框')
    ok(projects.value.length === 1 && projects.value[0].name === 'Beta', '从本地列表摘掉')
    ok(/已移除项目记录/.test(notifications[0] || ''), '只移记录时的提示文案', String(notifications[0]))

    // 失败:不摘除本地项
    reset()
    removeResult = { ok: false, error: '文件被占用' }
    const projects2 = ref([PROJ('a', 'Alpha')])
    const d2 = useProjectDelete({
      projects: projects2, policy: 'ask',
      notify: (m) => notifications.push(m),
      dropLocal: (id) => { projects2.value = projects2.value.filter((p) => p._id !== id) }
    })
    d2.askDelete(PROJ('a', 'Alpha'))
    d2.confirmDelete()
    ok(notifications[0] === '文件被占用', '失败时提示服务端原因', String(notifications[0]))
    ok(projects2.value.length === 1, '失败时列表不变(不能假装删掉了)')
    ok(d2.showDelete.value === true, '失败时确认框保持打开')

    // 连文件删的提示文案
    reset()
    const projects3 = ref([PROJ('a', 'Alpha')])
    const d3 = useProjectDelete({
      projects: projects3, policy: 'always',
      notify: (m) => notifications.push(m),
      dropLocal: (id) => { projects3.value = projects3.value.filter((p) => p._id !== id) }
    })
    d3.askDelete(PROJ('a', 'Alpha'))
    d3.confirmDelete()
    ok(/已删除项目及文件/.test(notifications[0] || ''), '连文件删时的提示文案', String(notifications[0]))
  }

  // ---------- 结果 ----------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
