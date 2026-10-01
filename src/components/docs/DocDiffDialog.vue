<!-- 跨版本 API 差异对比:选两个已生成的文档库,看新增/移除/有变化的类,展开看成员级明细。
     用于升级引擎前评估破坏性变更。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import type { DocClassDiff, DocLibraryDiff, DocLibraryStatus } from '../../types/godot'

const props = defineProps<{
  open: boolean
  /** 可参与对比的库(已生成的) */
  libraries: { versionId: string, tag: string, status: DocLibraryStatus | null }[]
  /** 预选的基准库(A) */
  initialA?: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const versionA = ref('')
const versionB = ref('')
const summary = ref<DocLibraryDiff | null>(null)
/** 展开中的类 → 其成员级差异 */
const detail = ref<Record<string, DocClassDiff | null>>({})
const showGroup = ref<Record<string, boolean>>({ added: true, removed: true, changed: true })

const readyLibs = computed(() => props.libraries.filter((l) => l.status?.status === 'ready'))

watch(() => props.open, (open) => {
  if (!open) return
  detail.value = {}
  summary.value = null
  const list = readyLibs.value
  versionA.value = (props.initialA && list.some((l) => l.versionId === props.initialA))
    ? props.initialA
    : (list[0]?.versionId ?? '')
  versionB.value = (list.find((l) => l.versionId !== versionA.value)?.versionId) ?? ''
  run()
})

async function run() {
  detail.value = {}
  if (!versionA.value || !versionB.value || versionA.value === versionB.value) {
    summary.value = null
    return
  }
  summary.value = await window.services.docsDiffLibraries(versionA.value, versionB.value)
}

function swap() {
  const a = versionA.value
  versionA.value = versionB.value
  versionB.value = a
  run()
}

function tagOf(id: string): string {
  return readyLibs.value.find((l) => l.versionId === id)?.tag ?? id
}

/** 展开某类的成员级差异(按需读正文对比) */
async function toggleClass(name: string) {
  if (name in detail.value) {
    const next = { ...detail.value }
    delete next[name]
    detail.value = next
    return
  }
  const r = await window.services.docsDiffClass(versionA.value, versionB.value, name)
  detail.value = { ...detail.value, [name]: r.ok && r.diff ? r.diff : null }
}

/** 成员差异按组渲染:统一结构,便于复用一段模板 */
const GROUPS = [
  { key: 'methods', label: '方法' },
  { key: 'members', label: '成员' },
  { key: 'signals', label: '信号' },
  { key: 'constants', label: '常量' },
  { key: 'enums', label: '枚举' }
] as const

function groupHasChanges(g: DocClassDiff, key: string): boolean {
  const grp = (g as unknown as Record<string, { added: string[], removed: string[], changed: unknown[] }>)[key]
  return !!grp && (grp.added.length > 0 || grp.removed.length > 0 || grp.changed.length > 0)
}

function classChangeCount(g: DocClassDiff): number {
  let n = 0
  for (const { key } of GROUPS) {
    const grp = (g as unknown as Record<string, { added: string[], removed: string[], changed: unknown[] }>)[key]
    if (grp) n += grp.added.length + grp.removed.length + grp.changed.length
  }
  return n
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog">
        <div class="head">
          <Icon name="layers" :size="15" />
          <span class="title">跨版本 API 差异</span>
          <span class="grow"></span>
          <button class="x" title="关闭" @click="emit('close')"><Icon name="x" :size="14" /></button>
        </div>

        <div v-if="readyLibs.length < 2" class="empty">
          至少需要两个已生成的文档库才能对比 —— 到「文档」页为另一个引擎版本生成,或导入 API 文件。
        </div>

        <template v-else>
          <div class="picker">
            <select v-model="versionA" class="ver" @change="run">
              <option v-for="l in readyLibs" :key="l.versionId" :value="l.versionId">{{ l.tag }}</option>
            </select>
            <button class="swap" title="交换两侧" @click="swap"><Icon name="refresh" :size="13" /></button>
            <select v-model="versionB" class="ver" @change="run">
              <option v-for="l in readyLibs" :key="l.versionId" :value="l.versionId">{{ l.tag }}</option>
            </select>
            <span class="hint-side">基准 → 目标</span>
          </div>

          <div v-if="summary && !summary.ok" class="empty">{{ summary.error }}</div>

          <div v-else-if="summary" class="body">
            <div class="stats">
              <span class="stat add">新增 {{ summary.addedClasses?.length ?? 0 }} 类</span>
              <span class="stat rm">移除 {{ summary.removedClasses?.length ?? 0 }} 类</span>
              <span class="stat chg">变化 {{ summary.changedClasses?.length ?? 0 }} 类</span>
            </div>

            <!-- 新增/移除:纯名单 -->
            <div v-for="grp in (['addedClasses', 'removedClasses'] as const)" :key="grp" class="group">
              <button class="group-head" @click="showGroup[grp] = !showGroup[grp]">
                <Icon :name="showGroup[grp] ? 'chevron-down' : 'chevron-right'" :size="11" />
                {{ grp === 'addedClasses' ? '新增的类' : '移除的类' }}
                <span class="cnt">{{ (summary[grp] ?? []).length }}</span>
              </button>
              <div v-if="showGroup[grp]" class="names">
                <button
                  v-for="n in (summary[grp] ?? [])"
                  :key="n"
                  class="name-chip"
                  :class="grp === 'addedClasses' ? 'add' : 'rm'"
                  @click="toggleClass(n)"
                >{{ n }}</button>
                <span v-if="!(summary[grp] ?? []).length" class="none">无</span>
              </div>
            </div>

            <!-- 有变化:可展开成员明细 -->
            <div class="group">
              <button class="group-head" @click="showGroup.changed = !showGroup.changed">
                <Icon :name="showGroup.changed ? 'chevron-down' : 'chevron-right'" :size="11" />
                有变化的类
                <span class="cnt">{{ summary.changedClasses?.length ?? 0 }}</span>
              </button>
              <template v-if="showGroup.changed">
                <div v-for="c in (summary.changedClasses ?? [])" :key="c.name" class="cls-row">
                  <button class="cls-head" @click="toggleClass(c.name)">
                    <Icon :name="c.name in detail ? 'chevron-down' : 'chevron-right'" :size="11" />
                    <span class="mono cls-name">{{ c.name }}</span>
                    <span class="cnt">{{ c.changes }} 处</span>
                  </button>
                  <div v-if="c.name in detail" class="cls-body">
                    <div v-if="!detail[c.name]" class="none">读取失败</div>
                    <template v-else>
                      <div v-if="detail[c.name]!.inherits" class="inherit-row">
                        继承变更:<span class="mono">{{ detail[c.name]!.inherits!.from ?? '无' }}</span>
                        →
                        <span class="mono">{{ detail[c.name]!.inherits!.to ?? '无' }}</span>
                      </div>
                      <div v-for="g in GROUPS" :key="g.key" class="sub">
                        <template v-if="groupHasChanges(detail[c.name]!, g.key)">
                          <div class="sub-head">{{ g.label }}</div>
                          <div
                            v-for="n in (detail[c.name] as any)[g.key].added"
                            :key="`a-${g.key}-${n}`"
                            class="line add"
                          >+ {{ n }}</div>
                          <div
                            v-for="n in (detail[c.name] as any)[g.key].removed"
                            :key="`r-${g.key}-${n}`"
                            class="line rm"
                          >− {{ n }}</div>
                          <div
                            v-for="ch in (detail[c.name] as any)[g.key].changed"
                            :key="`c-${g.key}-${ch.name}`"
                            class="line chg"
                          >
                            ~ {{ ch.name }}
                            <span class="mono from">{{ ch.from }}</span> → <span class="mono to">{{ ch.to }}</span>
                          </div>
                        </template>
                      </div>
                      <div v-if="classChangeCount(detail[c.name]!) === 0" class="none">无成员级变化(仅结构调整)</div>
                    </template>
                  </div>
                </div>
                <span v-if="!(summary.changedClasses ?? []).length" class="none">无</span>
              </template>
            </div>
          </div>
        </template>

        <div class="foot">
          <span class="foot-hint">{{ tagOf(versionA) }} → {{ tagOf(versionB) }}</span>
          <span class="grow"></span>
          <button class="btn small" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog {
  width: 760px;
  max-width: calc(100vw - 40px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lift);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}

.title {
  font-size: 13.5px;
  font-weight: 700;
}

.grow {
  flex: 1;
}

.x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.picker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.ver {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
}

.swap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.hint-side {
  font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.stats {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.stat {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  border: 1px solid var(--border);
}

.stat.add { color: var(--ok); background: var(--ok-weak); }
.stat.rm { color: var(--danger); background: var(--danger-weak); }
.stat.chg { color: var(--warn); background: var(--warn-weak); }

.group {
  margin-bottom: 12px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: none;
  background: none;
  padding: 5px 0;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.cnt {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 1px 7px;
}

.names {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 4px 0 2px 16px;
}

.name-chip {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: 11.5px;
  font-family: var(--mono);
  cursor: pointer;
}

.name-chip.add { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.name-chip.rm { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }

.cls-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 5px;
  overflow: hidden;
}

.cls-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: none;
  background: none;
  padding: 6px 9px;
  cursor: pointer;
  text-align: left;
}

.cls-name {
  font-size: 12.5px;
  color: var(--text);
}

.cls-body {
  padding: 2px 10px 8px 22px;
  border-top: 1px dashed var(--border);
}

.inherit-row {
  padding: 5px 0;
  font-size: 12px;
  color: var(--text-2);
}

.sub {
  margin-top: 6px;
}

.sub-head {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  margin-bottom: 2px;
}

.line {
  font-size: 11.5px;
  font-family: var(--mono);
  padding: 1px 0;
  word-break: break-all;
}

.line.add { color: var(--ok); }
.line.rm { color: var(--danger); }
.line.chg { color: var(--warn); }

.mono {
  font-family: var(--mono);
}

.from {
  color: var(--text-3);
}

.to {
  color: var(--brand);
}

.none {
  font-size: 11.5px;
  color: var(--text-3);
  padding: 2px 0 2px 16px;
}

.empty {
  padding: 30px 18px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
}

.foot-hint {
  font-size: 11.5px;
  color: var(--text-2);
  font-family: var(--mono);
}
</style>
