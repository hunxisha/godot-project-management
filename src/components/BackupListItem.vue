<script setup lang="ts">
// 备份列表条目(分组视图与时间轴视图共用)。
// 行式布局与项目页同一套语言:状态点 + 两行主体(第一行身份,第二行技术细节)。
// 行内只留「恢复」主按钮,其余操作收进「⋯」菜单;菜单开合由父级统一管理(同时只开一个)。
// 纯展示 + 事件上抛,不持有任何状态。
import { computed } from 'vue'
import Icon from './Icon.vue'
import { fmtSize, formatRelative, formatTime } from '../utils/format'
import type { BackupRecord } from '../types/godot'

const props = withDefaults(defineProps<{
  record: BackupRecord
  /** 项目记录已不存在:不能覆盖恢复 */
  orphan?: boolean
  batchMode?: boolean
  selected?: boolean
  busy?: boolean
  /** 时间轴视图需要显示项目名 */
  showProject?: boolean
  /** 本行「⋯」菜单是否展开 */
  menuOpen?: boolean
}>(), {
  orphan: false,
  batchMode: false,
  selected: false,
  busy: false,
  showProject: false,
  menuOpen: false
})

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'restore'): void
  (e: 'rename'): void
  (e: 'verify'): void
  (e: 'remove'): void
  (e: 'reveal'): void
  /** 「⋯」按钮点击:父级 toggle 菜单 */
  (e: 'menu'): void
  /** 菜单项被点击:父级收起菜单后再执行动作 */
  (e: 'menu-close'): void
}>()

/** 标题:优先备注名,否则项目名;时间等细节放第二行,不再塞进标题 */
const title = computed(() => props.record.label || props.record.projectName || '备份')

const modeLabel = computed(() => (props.record.mode === 'zip' ? 'zip' : '快照'))

/** 校验状态:missing 优先,其次 verified / 未校验 */
const verifyState = computed<'missing' | 'ok' | 'bad' | 'none'>(() => {
  if (props.record.missing) return 'missing'
  if (props.record.verified === true) return 'ok'
  if (props.record.verified === false) return 'bad'
  return 'none'
})

const verifyText = computed(() => {
  switch (verifyState.value) {
    case 'missing': return '文件缺失'
    case 'ok': return '有效'
    case 'bad': return '无效'
    default: return '未校验'
  }
})

const verifying = computed(() => props.busy)
</script>

<template>
  <div class="bk-row" :class="{ missing: record.missing, selected }">
    <label v-if="batchMode" class="bk-check">
      <input
        type="checkbox"
        class="chk"
        :checked="selected"
        :disabled="busy"
        @change="emit('toggle')"
      />
    </label>
    <span v-else class="bk-dot" :class="verifyState" :title="verifyText" />

    <div class="bk-main">
      <!-- 第一行:身份(备注/项目名)+ 属性标签 + 校验结论 -->
      <div class="bk-line">
        <span class="bk-title" :title="record.label || record.destPath">{{ title }}</span>
        <span v-if="showProject && record.label" class="bk-proj">{{ record.projectName }}</span>
        <span class="tag">{{ modeLabel }}</span>
        <span v-if="record.level && record.mode === 'zip'" class="tag">L{{ record.level }}</span>
        <span v-if="record.engineVersion" class="tag">{{ record.engineVersion }}</span>
        <span v-if="record.includeCache" class="tag" title="包含 .godot 编辑器缓存">含缓存</span>
        <span v-if="orphan" class="tag warn"><Icon name="alert" :size="10" /> 项目已移除</span>
        <span class="grow"></span>
        <span
          class="bk-verify"
          :class="verifyState"
          :title="record.verifyError || verifyText"
        >
          <span v-if="verifying" class="spin"></span>
          <Icon v-else :name="verifyState === 'ok' ? 'shield-check' : 'alert'" :size="11" />
          {{ verifyText }}
        </span>
      </div>
      <!-- 第二行:技术细节(路径 · 体积 · 文件数 · 相对时间) -->
      <div class="bk-sub">
        <span class="bk-path mono" :title="record.destPath">{{ record.destPath }}</span>
        <span class="bk-meta">{{ fmtSize(record.size) }}</span>
        <span class="bk-meta">{{ record.fileCount ?? 0 }} 文件</span>
        <span class="bk-meta" :title="formatTime(record.createdAt)">
          {{ formatRelative(record.createdAt) }}
        </span>
      </div>
    </div>

    <div v-if="!batchMode" class="bk-acts">
      <button
        class="btn small primary"
        :disabled="busy || record.missing"
        :title="record.missing ? '备份文件已不存在,无法恢复' : '从这份备份恢复'"
        @click="emit('restore')"
      >
        <Icon name="upload" :size="12" /> 恢复
      </button>
      <div class="row-menu-wrap">
        <button
          class="btn small icon-act more"
          :class="{ on: menuOpen }"
          title="更多操作"
          @click="emit('menu')"
        >
          <Icon name="more" :size="16" :stroke-width="3" />
        </button>
        <div v-if="menuOpen" class="row-menu">
          <button
            class="menu-item"
            :disabled="record.missing"
            :title="record.missing ? '文件已丢失,无法校验' : '校验备份内容是否可用'"
            @click="emit('verify'); emit('menu-close')"
          >
            <Icon name="shield-check" :size="13" /> 校验备份
          </button>
          <button class="menu-item" @click="emit('rename'); emit('menu-close')">
            <Icon name="pen" :size="13" /> 编辑备注
          </button>
          <button class="menu-item" @click="emit('reveal'); emit('menu-close')">
            <Icon name="external" :size="13" /> 定位文件
          </button>
          <div class="menu-sep"></div>
          <button
            class="menu-item danger"
            :title="record.missing ? '只移除数据库里的记录' : '删除备份文件(移入回收站)'"
            @click="emit('remove'); emit('menu-close')"
          >
            <Icon name="trash" :size="13" /> {{ record.missing ? '移除记录' : '删除备份' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* flush 行:铺满分组面板,行间细线分隔,hover 整行高亮(同项目列表行语言) */
.bk-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  transition: background 0.13s, box-shadow 0.13s;
}

.bk-row + .bk-row {
  border-top: 1px solid var(--surface-2);
}

.bk-row:hover {
  background: var(--surface-2);
}

/* 批量选中:品牌弱底 + 左侧品牌内嵌条 */
.bk-row.selected {
  background: var(--brand-weak);
  box-shadow: inset 2px 0 0 var(--brand);
}

.bk-row.missing {
  opacity: 0.62;
}

.bk-check {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

/* 状态点:颜色即结论 */
.bk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}

.bk-dot.ok { background: var(--ok); }
.bk-dot.bad,
.bk-dot.missing { background: var(--danger); }
.bk-dot.none { background: var(--border-strong); }

.bk-main {
  flex: 1;
  min-width: 0;
}

.bk-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bk-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.bk-proj {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bk-verify {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.bk-verify.ok { color: var(--ok); }
.bk-verify.bad,
.bk-verify.missing { color: var(--danger); }
.bk-verify.none { color: var(--text-3); }

/* 第二行:路径可收缩出省略号,体积/文件数/时间依次靠右 */
.bk-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
  min-width: 0;
}

.bk-path {
  flex: 1;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bk-meta {
  flex-shrink: 0;
  white-space: nowrap;
}

.bk-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 「更多」按钮:纯图标,无框无底色,反馈只靠圆点变色(与项目页同款) */
.icon-act.more,
.icon-act.more:hover,
.icon-act.more.on {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.icon-act.more {
  width: 28px;
  padding: 3px 0;
  color: var(--text-2);
}

.icon-act.more:hover,
.icon-act.more.on {
  color: var(--brand);
}

/* ---------- 行内「更多」菜单 ---------- */

.row-menu-wrap {
  position: relative;
  display: flex;
}

.row-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  min-width: 156px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lift);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text-2);
  background: none;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.menu-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.menu-item.danger {
  color: var(--danger);
}

.menu-item.danger:hover {
  background: var(--danger-weak);
}

.menu-sep {
  height: 1px;
  margin: 5px 6px;
  background: var(--border);
}
</style>
